// server.js (demo) - run with: node server.js
const express = require('express');
const bodyParser = require('body-parser');
const webpush = require('web-push');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// In-memory stores (replace with DB for production)
const subscriptions = {};        // phone -> subscription object
const contactHashes = {};       // phone -> [hash1, hash2, ...]
const requests = {};            // requestId -> request object
const approvals = {};           // requestId -> {phone: decision}

// VAPID keys: generate once and persist. Here we generate on start (demo).
const vapidKeys = webpush.generateVAPIDKeys();
console.log('VAPID Public Key (save & reuse):', vapidKeys.publicKey);
webpush.setVapidDetails('mailto:you@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

// utils
function sha256hex(str){ return crypto.createHash('sha256').update(str).digest('hex'); }

// endpoints

// return VAPID public key
app.get('/vapidPublicKey', (req,res)=> res.send(vapidKeys.publicKey));

// save subscription (phone + subscription)
app.post('/save-subscription', (req,res)=>{
  const {phone, subscription} = req.body;
  if(!phone || !subscription) return res.status(400).json({error:'phone+subscription required'});
  subscriptions[phone] = subscription;
  console.log('Saved subscription for', phone);
  res.json({ok:true});
});

// save hashed contacts for a user
app.post('/save-contacts', (req,res)=>{
  const {phone, contactHashes: hashes} = req.body;
  if(!phone || !Array.isArray(hashes)) return res.status(400).json({error:'phone + contactHashes[] required'});
  contactHashes[phone] = hashes;
  res.json({ok:true});
});

// create a request: type 'txn' or 'transfer'
// for transfer: {type:'transfer', from:A, via:B, to:C, amount}
app.post('/create-request', async (req,res)=>{
  const r = req.body;
  if(!r || !r.type) return res.status(400).json({error:'type required'});
  const id = Math.random().toString(36).slice(2,9);
  const entry = {requestId:id, ...r, status:'pending', created: new Date().toISOString()};
  requests[id] = entry;
  approvals[id] = {};
  // For txn: notify recipient 'to'; for transfer: notify both 'via' and 'to' (and optionally from)
  try {
    if(r.type === 'txn'){
      const to = r.to;
      if(!subscriptions[to]) return res.json({ok:false, error:'recipient not subscribed'});
      const payload = { title:'Transaction Approval', body:`Approve ₹${r.amount} from ${r.from}?`, requestId:id, serverEndpoint: `http://${req.headers.host}`, approverPhone: to };
      await webpush.sendNotification(subscriptions[to], JSON.stringify(payload));
      res.json({ok:true, requestId:id});
    } else if(r.type === 'transfer'){
      const A = r.from, B = r.via, C = r.to;
      // Mutual contacts check: ensure each's contactHashes contains the other two hashes
      const hashA = sha256hex(A), hashB = sha256hex(B), hashC = sha256hex(C);
      function hasPair(x, yHash){ return Array.isArray(contactHashes[x]) && contactHashes[x].includes(yHash); }
      const okAB = hasPair(A, hashB), okAC = hasPair(A, hashC);
      const okBA = hasPair(B, hashA), okBC = hasPair(B, hashC);
      const okCA = hasPair(C, hashA), okCB = hasPair(C, hashB);
      const mutual = okAB && okAC && okBA && okBC && okCA && okCB;
      if(!mutual){
        entry.status = 'mutual-check-failed'; requests[id] = entry;
        return res.json({ok:false, status:'mutual-check-failed', error:'Mutual contacts check failed'});
      }
      // notify B and C
      const subs = [];
      if(subscriptions[B]) subs.push({sub:subscriptions[B], phone:B});
      if(subscriptions[C]) subs.push({sub:subscriptions[C], phone:C});
      const payload = { title:'Transfer Approval', body: `Approve transfer of ₹${r.amount} from ${A} (debt transfer) ?`, requestId:id, serverEndpoint: `http://${req.headers.host}` };
      // Add approverPhone in per-notification payload
      for(const s of subs){
        const p = Object.assign({}, payload, {approverPhone: s.phone});
        await webpush.sendNotification(s.sub, JSON.stringify(p)).catch(e=>console.warn('push fail',e));
      }
      res.json({ok:true, requestId:id});
    } else {
      res.status(400).json({error:'unsupported type'});
    }
  } catch(e){
    console.warn('create-request failed', e);
    res.status(500).json({error:e.message});
  }
});

// get pending requests relevant to a phone
app.get('/pending-for/:phone', (req,res)=>{
  const phone = req.params.phone;
  const out = Object.values(requests).filter(r => {
    if(r.type === 'txn') return r.to === phone || r.from === phone;
    if(r.type === 'transfer') return r.from===phone || r.via===phone || r.to===phone;
    return false;
  }).map(r=> ({ requestId: r.requestId, type: r.type, from: r.from, to: r.to, via: r.via, amount: r.amount, note: r.note, status: r.status }) );
  res.json(out);
});

// record approval decision (approver phone + decision yes/no)
app.post('/record-approval', (req,res)=>{
  const {requestId, approver, decision} = req.body;
  if(!requestId || !approver || !decision) return res.status(400).json({error:'requestId+approver+decision required'});
  if(!requests[requestId]) return res.status(404).json({error:'notfound'});
  approvals[requestId][approver] = decision === 'yes';
  // finalize logic:
  const reqObj = requests[requestId];
  if(reqObj.type === 'txn'){
    // require recipient (=to) approval
    if(approvals[requestId][reqObj.to] === true){
      reqObj.status = 'approved';
      // notify originator (if subscribed)
      const s = subscriptions[reqObj.from];
      if(s) webpush.sendNotification(s, JSON.stringify({title:'Txn Approved', body:`Your txn ${requestId} was approved`, requestId}));
    } else if(approvals[requestId][reqObj.to] === false){
      reqObj.status = 'rejected';
      const s = subscriptions[reqObj.from];
      if(s) webpush.sendNotification(s, JSON.stringify({title:'Txn Rejected', body:`Your txn ${requestId} was rejected`, requestId}));
    }
  } else if(reqObj.type === 'transfer'){
    // require both via (B) and to (C) be true
    const A = reqObj.from, B = reqObj.via, C = reqObj.to;
    const aB = approvals[requestId][B]===true;
    const aC = approvals[requestId][C]===true;
    const rB = approvals[requestId][B]===false;
    const rC = approvals[requestId][C]===false;
    if(aB && aC){
      reqObj.status = 'approved';
      // notify A,B,C
      [A,B,C].forEach(p=>{
        if(subscriptions[p]) webpush.sendNotification(subscriptions[p], JSON.stringify({title:'Transfer Approved', body:`Request ${requestId} approved`, requestId})).catch(e=>console.warn(e));
      });
    } else if(rB || rC){
      reqObj.status = 'rejected';
      [A,B,C].forEach(p=>{
        if(subscriptions[p]) webpush.sendNotification(subscriptions[p], JSON.stringify({title:'Transfer Rejected', body:`Request ${requestId} rejected`, requestId})).catch(e=>console.warn(e));
      });
    }
  }
  res.json({ok:true, status: requests[requestId].status || 'pending'});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('Server listening on', PORT));

// BBDHm-y9zBD8JC6EGTlIadAbmrTKrV2F0VnLdrDGAGXRJE1hFkZNAVncBNerhHMuu9q4TNu8W6mk5myZZ-KB6_c