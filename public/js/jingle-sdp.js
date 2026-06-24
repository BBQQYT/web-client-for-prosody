'use strict';

/* global window */

/**
 * SDP <-> Jingle conversion for WebRTC calls (Conversations/Dino compatible).
 *
 * Implements the mapping between the browser's SDP and Jingle XML:
 *   - XEP-0166 Jingle
 *   - XEP-0167 Jingle RTP (payload-types, sources/SSMA, rtcp-fb, hdrext)
 *   - XEP-0176 ICE-UDP transport (candidates, ufrag/pwd)
 *   - XEP-0320 DTLS-SRTP (fingerprint + setup)
 *   - XEP-0338 BUNDLE grouping
 *
 * SDP is parsed into a neutral structure and serialized either direction, so
 * the same model feeds both `sdpToJingle` and `jingleToSdp`.
 */

const JNS = {
  JINGLE: 'urn:xmpp:jingle:1',
  RTP: 'urn:xmpp:jingle:apps:rtp:1',
  RTP_HDREXT: 'urn:xmpp:jingle:apps:rtp:rtp-hdrext:0',
  RTP_FB: 'urn:xmpp:jingle:apps:rtp:rtcp-fb:0',
  RTP_SSMA: 'urn:xmpp:jingle:apps:rtp:ssma:0',
  ICE: 'urn:xmpp:jingle:transports:ice-udp:1',
  DTLS: 'urn:xmpp:jingle:apps:dtls:0',
  GROUP: 'urn:xmpp:jingle:apps:grouping:0',
};

/* ----------------------------- SDP parsing ----------------------------- */

function splitLines(sdp) { return sdp.split(/\r\n|\r|\n/).filter(Boolean); }

// Parse an SDP string into { groups, msidSemantic, medias[] }.
function parseSdp(sdp) {
  const lines = splitLines(sdp);
  const out = { groups: [], medias: [] };
  let media = null;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      const m = /^m=(\w+) (\d+) ([\w/]+) (.*)$/.exec(line);
      media = {
        type: m[1], port: m[2], protocol: m[3],
        payloadOrder: m[4].split(' ').filter(Boolean),
        mid: '', direction: 'sendrecv', rtcpMux: false,
        payloads: {}, hdrext: [], sources: {}, ssrcGroups: [],
        ice: { ufrag: '', pwd: '', candidates: [], options: '' },
        fingerprint: null, setup: '',
      };
      out.medias.push(media);
      continue;
    }
    if (!media) { // session-level
      if (line.startsWith('a=group:')) {
        const parts = line.slice(8).split(' ');
        out.groups.push({ semantics: parts[0], contents: parts.slice(1) });
      } else if (line.startsWith('a=msid-semantic:')) {
        out.msidSemantic = line.slice(16).trim();
      }
      continue;
    }
    // media-level
    if (line.startsWith('a=mid:')) media.mid = line.slice(6).trim();
    else if (line === 'a=rtcp-mux') media.rtcpMux = true;
    else if (/^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) media.direction = line.slice(2);
    else if (line.startsWith('a=ice-ufrag:')) media.ice.ufrag = line.slice(12).trim();
    else if (line.startsWith('a=ice-pwd:')) media.ice.pwd = line.slice(10).trim();
    else if (line.startsWith('a=ice-options:')) media.ice.options = line.slice(14).trim();
    else if (line.startsWith('a=fingerprint:')) {
      const fp = line.slice(14).trim().split(' ');
      media.fingerprint = { hash: fp[0], value: fp[1] };
    } else if (line.startsWith('a=setup:')) media.setup = line.slice(8).trim();
    else if (line.startsWith('a=rtpmap:')) {
      const m = /^a=rtpmap:(\d+) ([\w-]+)\/(\d+)(?:\/(\d+))?/.exec(line);
      const id = m[1];
      const p = media.payloads[id] || (media.payloads[id] = { id, parameters: [], fb: [] });
      p.name = m[2]; p.clockrate = m[3]; if (m[4]) p.channels = m[4];
    } else if (line.startsWith('a=fmtp:')) {
      const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
      const p = media.payloads[m[1]] || (media.payloads[m[1]] = { id: m[1], parameters: [], fb: [] });
      for (const kv of m[2].split(';')) {
        const eq = kv.indexOf('=');
        if (eq > 0) p.parameters.push({ name: kv.slice(0, eq).trim(), value: kv.slice(eq + 1).trim() });
        else if (kv.trim()) p.parameters.push({ name: '', value: kv.trim() });
      }
    } else if (line.startsWith('a=rtcp-fb:')) {
      const m = /^a=rtcp-fb:(\*|\d+) ([\w-]+)(?: ([\w-]+))?/.exec(line);
      const fb = { type: m[2], subtype: m[3] || '' };
      if (m[1] === '*') { media._fbAll = media._fbAll || []; media._fbAll.push(fb); }
      else { const p = media.payloads[m[1]] || (media.payloads[m[1]] = { id: m[1], parameters: [], fb: [] }); p.fb.push(fb); }
    } else if (line.startsWith('a=extmap:')) {
      const m = /^a=extmap:(\d+)(?:\/\w+)? (\S+)/.exec(line);
      media.hdrext.push({ id: m[1], uri: m[2] });
    } else if (line.startsWith('a=ssrc-group:')) {
      const parts = line.slice(13).split(' ');
      media.ssrcGroups.push({ semantics: parts[0], sources: parts.slice(1) });
    } else if (line.startsWith('a=ssrc:')) {
      const m = /^a=ssrc:(\d+) ([\w-]+)(?::(.*))?$/.exec(line);
      const src = media.sources[m[1]] || (media.sources[m[1]] = { ssrc: m[1], parameters: [] });
      if (m[2]) src.parameters.push({ name: m[2], value: m[3] || '' });
    } else if (line.startsWith('a=candidate:')) {
      media.ice.candidates.push(parseCandidate(line.slice(2)));
    }
  }
  // attach media-level fb to every payload that lacks it
  for (const md of out.medias) {
    if (md._fbAll) for (const id of Object.keys(md.payloads)) md.payloads[id].fb.push(...md._fbAll);
  }
  return out;
}

// "candidate:foundation comp proto prio ip port typ type ..." -> object
function parseCandidate(str) {
  const t = str.replace(/^candidate:/, '').split(' ');
  const c = {
    foundation: t[0], component: t[1], protocol: t[2], priority: t[3],
    ip: t[4], port: t[5], type: t[7],
  };
  for (let i = 8; i < t.length - 1; i += 2) {
    if (t[i] === 'raddr') c.relAddr = t[i + 1];
    else if (t[i] === 'rport') c.relPort = t[i + 1];
    else if (t[i] === 'generation') c.generation = t[i + 1];
    else if (t[i] === 'tcptype') c.tcptype = t[i + 1];
    else if (t[i] === 'network-id') c.network = t[i + 1];
  }
  return c;
}

/* --------------------------- SDP -> Jingle ---------------------------- */

function sdpToJingle($build, parsed, { action, sid, initiator, responder, creator }) {
  const j = $build('jingle', { xmlns: JNS.JINGLE, action, sid });
  if (initiator) j.attrs({ initiator });
  if (responder) j.attrs({ responder });

  if (parsed.groups.length) {
    for (const g of parsed.groups) {
      j.c('group', { xmlns: JNS.GROUP, semantics: g.semantics });
      for (const name of g.contents) j.c('content', { name }).up();
      j.up();
    }
  }

  for (const md of parsed.medias) {
    j.c('content', { creator: creator || 'initiator', name: md.mid, senders: sendersFromDir(md.direction) });

    // --- description (RTP) ---
    j.c('description', { xmlns: JNS.RTP, media: md.type });
    for (const id of md.payloadOrder) {
      const p = md.payloads[id];
      if (!p) continue;
      const attrs = { id: p.id, name: p.name, clockrate: p.clockrate };
      if (p.channels) attrs.channels = p.channels;
      j.c('payload-type', attrs);
      for (const par of p.parameters) j.c('parameter', par.name ? { name: par.name, value: par.value } : { value: par.value }).up();
      for (const fb of p.fb) j.c('rtcp-fb', fb.subtype ? { xmlns: JNS.RTP_FB, type: fb.type, subtype: fb.subtype } : { xmlns: JNS.RTP_FB, type: fb.type }).up();
      j.up();
    }
    for (const ext of md.hdrext) j.c('rtp-hdrext', { xmlns: JNS.RTP_HDREXT, id: ext.id, uri: ext.uri }).up();
    if (md.rtcpMux) j.c('rtcp-mux').up();
    for (const g of md.ssrcGroups) {
      j.c('ssrc-group', { xmlns: JNS.RTP_SSMA, semantics: g.semantics });
      for (const s of g.sources) j.c('source', { ssrc: s }).up();
      j.up();
    }
    for (const ssrc of Object.keys(md.sources)) {
      const src = md.sources[ssrc];
      j.c('source', { xmlns: JNS.RTP_SSMA, ssrc });
      for (const par of src.parameters) j.c('parameter', { name: par.name, value: par.value }).up();
      j.up();
    }
    j.up(); // description

    // --- transport (ICE-UDP + DTLS) ---
    j.c('transport', { xmlns: JNS.ICE, ufrag: md.ice.ufrag, pwd: md.ice.pwd });
    if (md.fingerprint) {
      j.c('fingerprint', { xmlns: JNS.DTLS, hash: md.fingerprint.hash, setup: md.setup || 'actpass' })
        .t(md.fingerprint.value).up();
    }
    for (const c of md.ice.candidates) j.cnode(candidateToJingleNode(c)).up();
    j.up(); // transport

    j.up(); // content
  }
  return j;
}

function candidateToJingleNode(c) {
  // Build a candidate element via DOM (Strophe Builder cnode wants a node).
  const el = window.document.createElementNS(JNS.ICE, 'candidate');
  el.setAttribute('component', c.component);
  el.setAttribute('foundation', c.foundation);
  el.setAttribute('generation', c.generation || '0');
  el.setAttribute('id', c.id || ('c' + Math.random().toString(36).slice(2, 10)));
  el.setAttribute('ip', c.ip);
  el.setAttribute('network', c.network || '0');
  el.setAttribute('port', c.port);
  el.setAttribute('priority', c.priority);
  el.setAttribute('protocol', c.protocol);
  el.setAttribute('type', c.type);
  if (c.relAddr) el.setAttribute('rel-addr', c.relAddr);
  if (c.relPort) el.setAttribute('rel-port', c.relPort);
  if (c.tcptype) el.setAttribute('tcptype', c.tcptype);
  return el;
}

function sendersFromDir(dir) {
  return { sendrecv: 'both', sendonly: 'initiator', recvonly: 'responder', inactive: 'none' }[dir] || 'both';
}
function dirFromSenders(senders, isInitiator) {
  if (senders === 'both') return 'sendrecv';
  if (senders === 'none') return 'inactive';
  const me = isInitiator ? 'initiator' : 'responder';
  return senders === me ? 'sendonly' : 'recvonly';
}

/* --------------------------- Jingle -> SDP ---------------------------- */

function kids(el, name, ns) {
  const out = [];
  if (!el) return out;
  for (let i = 0; i < el.childNodes.length; i++) {
    const k = el.childNodes[i];
    if (k.nodeType !== 1) continue;
    if (name && k.localName !== name && k.nodeName !== name) continue;
    // Tolerate a null namespaceURI: Strophe.Builder elements carry xmlns as a
    // plain attribute (no real NS), while stanzas parsed off the wire are fully
    // NS-aware. Only reject when the element HAS a namespace that differs.
    if (ns && k.namespaceURI && k.namespaceURI !== ns) continue;
    out.push(k);
  }
  return out;
}
function kid(el, name, ns) { return kids(el, name, ns)[0] || null; }

// Convert an incoming <jingle> element to an SDP string. `isInitiator` is true
// when WE initiated (so the remote is the responder), affecting direction.
function jingleToSdp(jingleEl, { isInitiator } = {}) {
  const contents = kids(jingleEl, 'content');
  const mids = contents.map((c) => c.getAttribute('name'));
  const lines = [
    'v=0',
    'o=- ' + Date.now() + ' 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
  ];
  const groupEl = kid(jingleEl, 'group', JNS.GROUP);
  if (groupEl) {
    const gnames = kids(groupEl, 'content').map((c) => c.getAttribute('name'));
    lines.push('a=group:' + (groupEl.getAttribute('semantics') || 'BUNDLE') + ' ' + gnames.join(' '));
  }
  lines.push('a=msid-semantic: WMS *');

  for (const content of contents) {
    const desc = kid(content, 'description', JNS.RTP);
    const transport = kid(content, 'transport', JNS.ICE);
    const media = desc ? desc.getAttribute('media') : 'audio';
    const payloads = desc ? kids(desc, 'payload-type') : [];
    const pids = payloads.map((p) => p.getAttribute('id'));

    lines.push('m=' + media + ' 9 UDP/TLS/RTP/SAVPF ' + pids.join(' '));
    lines.push('c=IN IP4 0.0.0.0');
    lines.push('a=rtcp:9 IN IP4 0.0.0.0');

    if (transport) {
      if (transport.getAttribute('ufrag')) lines.push('a=ice-ufrag:' + transport.getAttribute('ufrag'));
      if (transport.getAttribute('pwd')) lines.push('a=ice-pwd:' + transport.getAttribute('pwd'));
      lines.push('a=ice-options:trickle');
      const fp = kid(transport, 'fingerprint', JNS.DTLS);
      if (fp) {
        lines.push('a=fingerprint:' + (fp.getAttribute('hash') || 'sha-256') + ' ' + (fp.textContent || '').trim());
        lines.push('a=setup:' + (fp.getAttribute('setup') || 'active'));
      }
    }
    lines.push('a=mid:' + (content.getAttribute('name') || ''));
    lines.push('a=' + dirFromSenders(content.getAttribute('senders') || 'both', isInitiator));
    if (kid(desc, 'rtcp-mux')) lines.push('a=rtcp-mux');

    for (const p of payloads) {
      const id = p.getAttribute('id');
      const name = p.getAttribute('name');
      const clock = p.getAttribute('clockrate') || '90000';
      const ch = p.getAttribute('channels');
      lines.push('a=rtpmap:' + id + ' ' + name + '/' + clock + (ch && ch !== '1' ? '/' + ch : ''));
      const params = kids(p, 'parameter').map((pa) => {
        const n = pa.getAttribute('name'); const v = pa.getAttribute('value');
        return n ? n + '=' + v : v;
      });
      if (params.length) lines.push('a=fmtp:' + id + ' ' + params.join(';'));
      for (const fb of kids(p, 'rtcp-fb', JNS.RTP_FB)) {
        lines.push('a=rtcp-fb:' + id + ' ' + fb.getAttribute('type') + (fb.getAttribute('subtype') ? ' ' + fb.getAttribute('subtype') : ''));
      }
    }
    for (const ext of kids(desc, 'rtp-hdrext', JNS.RTP_HDREXT)) {
      lines.push('a=extmap:' + ext.getAttribute('id') + ' ' + ext.getAttribute('uri'));
    }
    for (const g of kids(desc, 'ssrc-group', JNS.RTP_SSMA)) {
      const ss = kids(g, 'source').map((s) => s.getAttribute('ssrc'));
      lines.push('a=ssrc-group:' + g.getAttribute('semantics') + ' ' + ss.join(' '));
    }
    for (const src of kids(desc, 'source', JNS.RTP_SSMA)) {
      const ssrc = src.getAttribute('ssrc');
      for (const pa of kids(src, 'parameter')) {
        const v = pa.getAttribute('value');
        lines.push('a=ssrc:' + ssrc + ' ' + pa.getAttribute('name') + (v ? ':' + v : ''));
      }
    }
    if (transport) {
      for (const c of kids(transport, 'candidate', JNS.ICE)) lines.push('a=' + jingleCandidateToSdp(c));
    }
  }
  return lines.join('\r\n') + '\r\n';
}

function jingleCandidateToSdp(c) {
  let s = 'candidate:' + c.getAttribute('foundation') + ' ' + c.getAttribute('component') + ' ' +
    (c.getAttribute('protocol') || 'udp') + ' ' + c.getAttribute('priority') + ' ' +
    c.getAttribute('ip') + ' ' + c.getAttribute('port') + ' typ ' + c.getAttribute('type');
  if (c.getAttribute('rel-addr')) s += ' raddr ' + c.getAttribute('rel-addr');
  if (c.getAttribute('rel-port')) s += ' rport ' + c.getAttribute('rel-port');
  if (c.getAttribute('tcptype')) s += ' tcptype ' + c.getAttribute('tcptype');
  s += ' generation ' + (c.getAttribute('generation') || '0');
  return s;
}

/* ------------------- single trickled ICE candidate ------------------- */

// Build a Jingle <content><transport><candidate> for one trickled SDP candidate.
function iceCandidateToJingle($build, { candidate, sdpMid }, { sid, creator, ufrag, pwd }) {
  const cand = parseCandidate(candidate.replace(/^a=/, ''));
  const j = $build('jingle', { xmlns: JNS.JINGLE, action: 'transport-info', sid })
    .c('content', { creator: creator || 'initiator', name: sdpMid })
      .c('transport', { xmlns: JNS.ICE, ufrag: ufrag || '', pwd: pwd || '' });
  j.cnode(candidateToJingleNode(cand));
  return j;
}

window.JingleSDP = {
  JNS, parseSdp, sdpToJingle, jingleToSdp, iceCandidateToJingle,
  jingleCandidateToSdp, parseCandidate, kids, kid,
};
