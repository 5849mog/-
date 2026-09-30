// ==UserScript==
// @name         流光 · 视频探测与下载
// @namespace    liuguang.local
// @version      1.0.0
// @description  手机优先：多层视频探测、直链下载、HLS合并、播放录制与链接导出。无外部依赖、无上传。
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = '1.0.0', LIMIT = 384 * 1024 * 1024;
  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const isTop = window === window.top;
  const candidates = new Map(), blobs = new Map(), players = new Map();
  let root, panel, list, status, badge, rendered = false, renderTimer, scanTimer;
  let task = null, recorder = null, playerID = 0, lastURL = location.href;
  const roots = new Set([document]), observed = new WeakSet();
  const mediaExt = /\.(?:mp4|m4v|webm|mov|mkv|flv|avi|m3u8|mpd|mp3|m4a|aac|ogg)(?:[?#]|$)/i;
  const segmentExt = /\.(?:ts|m4s|cmfv|cmfa)(?:[?#]|$)/i;
  const mimeMedia = /^(?:video|audio)\/|mpegurl|dash\+xml/i;
  const safeName = s => (s || 'video').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120);
  const title = () => safeName(document.title || 'video');
  const sizeText = n => `${(n / 1048576).toFixed(1)} MB`;
  const abortError = () => new Error('已取消');
  function absolute(s, base = location.href) {
    try { const u = new URL(String(s).replace(/&amp;/g, '&'), base); return /^(https?:|blob:)$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
  }
  function kind(url, mime = '') {
    if (/mpegurl/i.test(mime) || /\.m3u8(?:[?#]|$)/i.test(url)) return 'HLS';
    if (/dash\+xml/i.test(mime) || /\.mpd(?:[?#]|$)/i.test(url)) return 'DASH';
    if (url.startsWith('blob:')) return 'BLOB';
    if (segmentExt.test(url)) return '分片';
    return '文件';
  }
  function add(url, source, meta = {}) {
    url = absolute(url, meta.base); if (!url) return;
    if (!meta.force && !mediaExt.test(url) && !mimeMedia.test(meta.mime || '') && !url.startsWith('blob:') && !segmentExt.test(url)) return;
    if (candidates.size >= 500 && !candidates.has(url)) return;
    const old = candidates.get(url);
    const item = { ...(old || {}), url, source: old ? old.source : source, type: kind(url, meta.mime || old?.mime), ...meta, drm: Boolean(old?.drm || meta.drm) };
    // Keep a player association when network discovery refreshes its URL.
    candidates.set(url, item);
    if (!isTop && !old && !url.startsWith('blob:')) {
      try { window.top.postMessage({ __liuguang: 1, url, source: `框架 · ${source}`, mime: meta.mime || '', ref: location.href }, '*'); } catch {}
    }
    scheduleRender();
  }
  function extract(text, source, base = location.href) {
    if (typeof text !== 'string') return;
    text = text.slice(0, 1500000).replace(/\\u002[fF]|\\\//g, '/').replace(/\\u0026/g, '&');
    const re = /(?:https?:\/\/|\/\/)[^\s"'<>\\]+/g;
    for (const match of text.matchAll(re)) add(match[0], source, { base });
    const rel = /["']([^"'\s]+\.(?:m3u8|mpd|mp4|webm|m4v|m4a)(?:\?[^"']*)?)["']/gi;
    for (const match of text.matchAll(rel)) add(match[1], source, { base });
  }
  function scheduleRender() {
    if (!isTop || renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 180);
  }
  const say = s => { if (status) status.textContent = s; };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  function button(text, fn, cls = '') { const b = el('button', cls, text); b.type = 'button'; b.onclick = fn; return b; }
  function fallbackSave(blob, filename) {
    const u = URL.createObjectURL(blob), a = el('a', 'save', `轻点保存 · ${filename}`);
    a.href = u; a.download = filename; a.target = '_blank'; a.rel = 'noopener';
    root.querySelector('.saves').append(a); a.click();
    // Keep an explicit, user-gesture download link for mobile browsers.
    setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 10 * 60 * 1000);
    say('已生成文件；若浏览器未保存，请轻点下方保存链接。');
  }
  async function copy(text) {
    try { if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text'); else await navigator.clipboard.writeText(text); say('已复制'); }
    catch { say('复制受限，请使用打开链接或导出。'); }
  }
  function openURL(url) { window.open(url, '_blank', 'noopener'); }
  function makeTask() {
    if (task || recorder) throw new Error('请先完成或取消当前任务');
    task = { controller: new AbortController(), bytes: 0, done: 0 };
    if (root) root.querySelector('.cancel').hidden = false;
    return task;
  }
  function finishTask(t) { if (task === t) task = null; if (root) root.querySelector('.cancel').hidden = !recorder; }
  function cancel() { if (task) task.controller.abort(); if (recorder && recorder.state !== 'inactive') recorder.stop(); }
  async function run(fn) {
    let t;
    try { t = makeTask(); await fn(t); }
    catch (e) { say(e.message || '操作失败'); }
    finally { if (t) finishTask(t); }
  }
  function request(url, type, t, headers = {}, ref = location.href) {
    const signal = t.controller.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      let handle, settled = false;
      const done = (fn, value) => { if (settled) return; settled = true; signal.removeEventListener('abort', stop); fn(value); };
      const stop = () => { try { handle?.abort(); } catch {} done(reject, abortError()); };
      signal.addEventListener('abort', stop, { once: true });
      try {
        handle = GM_xmlhttpRequest({ url, method: 'GET', responseType: type, timeout: 35000,
          headers: { Referer: ref, ...headers },
          onload: r => { if (r.status < 200 || r.status >= 300) return done(reject, new Error(`HTTP ${r.status}，链接可能过期或网站拒绝下载`)); done(resolve, r); },
          onerror: () => done(reject, new Error('请求失败：检查网络、跨域权限或登录状态')),
          ontimeout: () => done(reject, new Error('请求超时')), onabort: () => done(reject, abortError()),
          onprogress: e => { if (e.loaded > LIMIT) { done(reject, new Error('请求超过 384 MB 手机内存限制，请使用原生或外部下载器')); try { handle?.abort(); } catch {} } }
        });
      } catch (e) { done(reject, e); }
    });
  }
  async function retry(url, type, t, headers, ref) {
    for (let i = 0; ; i++) {
      try { return await request(url, type, t, headers, ref); }
      catch (e) { if (t.controller.signal.aborted || i === 2 || /HTTP 4\d\d/.test(e.message)) throw e; }
    }
  }
  async function binary(url, range, t, ref) {
    const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
    const r = await retry(url, 'arraybuffer', t, headers, ref);
    let a = new Uint8Array(r.response);
    if (range) {
      if (r.status === 200) {
        if (a.length < range.offset + range.length) throw new Error('服务器未返回完整字节范围');
        a = a.slice(range.offset, range.offset + range.length);
      } else {
        const cr = /content-range:\s*bytes\s+(\d+)-(\d+)\//i.exec(r.responseHeaders || '');
        if (!cr || Number(cr[1]) !== range.offset || a.length !== range.length) throw new Error('字节范围响应不正确');
      }
    }
    return a;
  }
  function attributes(line) {
    const out = {}; const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    for (const m of line.matchAll(re)) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }
  function parseHLS(text, base) {
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('返回内容不是 HLS 播放列表');
    const lines = text.split(/\r?\n/).map(l => l.trim());
    const variants = [], audios = [], segments = [];
    let key = null, map = null, sequence = 0, pendingRange = null, prevRange = null, duration = 0;
    let discontinuity = false;
    const resolve = s => { const u = absolute(s, base); if (!/^https?:/.test(u)) throw new Error('播放列表含不支持的资源地址'); return u; };
    const rangeOf = (s, url) => {
      if (!s) return null;
      const m = /^(\d+)(?:@(\d+))?$/.exec(s); if (!m) throw new Error('无效的字节范围');
      const length = Number(m[1]);
      const offset = m[2] !== undefined ? Number(m[2]) : prevRange?.url === url ? prevRange.offset + prevRange.length : NaN;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length <= 0) throw new Error('缺少有效字节范围偏移');
      const r = { offset, length }; prevRange = { url, ...r }; return r;
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = attributes(l); let j = i + 1; while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
        if (j >= lines.length) throw new Error('清晰度地址缺失');
        variants.push({ url: resolve(lines[j]), label: a.RESOLUTION || `${Math.round(Number(a.BANDWIDTH || 0) / 1000)} kbps`, audio: a.AUDIO }); i = j;
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = attributes(l); if (a.TYPE === 'AUDIO' && a.URI) audios.push({ url: resolve(a.URI), group: a['GROUP-ID'], label: a.NAME || a.LANGUAGE || '音轨' });
      } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(l.split(':')[1]);
      else if (l.startsWith('#EXT-X-KEY:')) {
        const a = attributes(l);
        if (a.METHOD === 'NONE') key = null;
        else {
          if (a.METHOD !== 'AES-128' || (a.KEYFORMAT && a.KEYFORMAT !== 'identity')) throw new Error('受保护流：不支持 DRM / SAMPLE-AES');
          if (!a.URI) throw new Error('缺少密钥地址');
          key = { url: resolve(a.URI), iv: a.IV || null };
        }
      } else if (l.startsWith('#EXT-X-MAP:')) {
        const a = attributes(l), url = resolve(a.URI); map = { url, range: rangeOf(a.BYTERANGE, url), key };
        if (key && !key.iv) throw new Error('加密初始化片段缺少 IV');
      } else if (l.startsWith('#EXT-X-BYTERANGE:')) pendingRange = l.slice(l.indexOf(':') + 1);
      else if (l.startsWith('#EXTINF:')) duration = Number(l.slice(8).split(',')[0]);
      else if (l === '#EXT-X-DISCONTINUITY') discontinuity = true;
      else if (l.startsWith('#EXT-X-GAP')) throw new Error('播放列表含缺失分片，无法完整合并');
      else if (l.startsWith('#EXT-X-DEFINE')) throw new Error('此播放列表使用变量地址，请导出链接交给专用下载器');
      else if (l && !l.startsWith('#')) {
        const url = resolve(l); segments.push({ url, range: rangeOf(pendingRange, url), key, map, sequence: sequence++, duration }); pendingRange = null; duration = 0;
      }
    }
    return { variants, audios, segments, live: !lines.includes('#EXT-X-ENDLIST'), discontinuity };
  }
  function ivBytes(iv, seq) {
    const a = new Uint8Array(16);
    if (iv) {
      const h = iv.replace(/^0x/i, ''); if (!/^[\da-f]{1,32}$/i.test(h)) throw new Error('无效 AES IV');
      const full = h.padStart(32, '0'); for (let i = 0; i < 16; i++) a[i] = parseInt(full.slice(i * 2, i * 2 + 2), 16);
    } else { let n = BigInt(seq); for (let i = 15; i >= 0; i--) { a[i] = Number(n & 255n); n >>= 8n; } }
    return a;
  }
  async function loadHLS(item, t) {
    const r = await retry(item.url, 'text', t, {}, item.ref);
    const base = r.finalUrl || item.url;
    const p = parseHLS(r.responseText || r.response, base);
    if (p.variants.length) {
      const box = root.querySelector('.choices'); box.replaceChildren(el('p', '', '选择清晰度；独立音轨会单独保存。'));
      for (const v of p.variants) {
        const externalAudio = p.audios.some(a => a.group === v.audio);
        box.append(button(`${v.label}${externalAudio ? ' · 视频轨' : ''}`, () => run(nt => loadHLS({ ...item, url: v.url, videoOnly: externalAudio }, nt))));
      }
      for (const a of p.audios) box.append(button(`音频 · ${a.label}`, () => run(nt => loadHLS({ ...item, url: a.url, audioOnly: true }, nt))));
      say('已读取清晰度'); return;
    }
    if (!p.segments.length) throw new Error('列表没有可下载的完整分片');
    if (p.segments.length > 10000) throw new Error('分片过多，请导出链接使用专用下载器');
    if (p.discontinuity) throw new Error('存在时间轴或编码切换，直接拼接可能损坏；请导出链接用专用下载器');
    if (p.live && !confirm('这是直播列表。只保存当前列表中的片段，不是完整直播。继续？')) return;
    const maps = new Set(p.segments.map(s => s.map && JSON.stringify(s.map)).filter(Boolean));
    if (maps.size > 1 || (maps.size && p.segments.some(s => !s.map))) throw new Error('初始化片段发生变化，请导出链接用专用下载器');
    const parts = new Array(p.segments.length), keyCache = new Map();
    const decrypt = async (bytes, key, seq) => {
      if (!key) return bytes;
      if (!crypto.subtle) throw new Error('浏览器缺少 Web Crypto，请在 HTTPS 页面操作');
      if (!keyCache.has(key.url)) keyCache.set(key.url, binary(key.url, null, t, item.ref).then(b => {
        if (b.length !== 16) throw new Error('AES 密钥长度不正确');
        return crypto.subtle.importKey('raw', b, { name: 'AES-CBC' }, false, ['decrypt']);
      }));
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes(key.iv, seq) }, await keyCache.get(key.url), bytes));
    };
    const count = bytes => { t.bytes += bytes.length; if (t.bytes > LIMIT) throw new Error('已达到 384 MB 手机内存限制，请复制链接使用外部下载器'); };
    let init = null;
    if (p.segments[0].map) { const m = p.segments[0].map; init = await decrypt(await binary(m.url, m.range, t, item.ref), m.key, 0); count(init); }
    let next = 0;
    const worker = async () => {
      while (next < p.segments.length) {
        if (t.controller.signal.aborted) throw abortError();
        const i = next++, s = p.segments[i];
        const b = await decrypt(await binary(s.url, s.range, t, item.ref), s.key, s.sequence);
        count(b); parts[i] = b; t.done++; say(`下载 ${t.done}/${parts.length} · ${sizeText(t.bytes)}`);
      }
    };
    const workers = Array.from({ length: Math.min(3, parts.length) }, worker);
    try { await Promise.all(workers); }
    catch (e) { t.controller.abort(); await Promise.allSettled(workers); throw e; }
    if (t.controller.signal.aborted) throw abortError();
    // Container is preserved. This is deliberately not a fake MP4 conversion.
    const first = parts[0], fmp4 = Boolean(init) || (first?.length > 8 && String.fromCharCode(...first.slice(4, 8)) === 'styp');
    const isTS = first?.[0] === 0x47;
    const ext = fmp4 ? (item.audioOnly ? 'm4a' : 'mp4') : isTS ? 'ts' : item.audioOnly ? 'aac' : 'bin';
    const mime = fmp4 ? (item.audioOnly ? 'audio/mp4' : 'video/mp4') : isTS ? 'video/mp2t' : 'application/octet-stream';
    fallbackSave(new Blob(init ? [init, ...parts] : parts, { type: mime }), `${title()}${item.videoOnly ? '_视频轨' : item.audioOnly ? '_音轨' : ''}${p.live ? '_直播片段' : ''}.${ext}`);
    parts.length = 0;
  }
  function extension(item) {
    const m = /\.([a-z\d]{2,5})$/i.exec(new URL(item.url).pathname);
    if (m) return m[1];
    return /audio/i.test(item.mime || '') ? 'm4a' : /webm/i.test(item.mime || '') ? 'webm' : 'mp4';
  }
  async function direct(item, t) {
    if (item.type === 'BLOB') {
      const b = blobs.get(item.url);
      if (!b) throw new Error('这是播放器虚拟地址（可能是 MSE），请寻找 HLS/DASH 网络源或使用录制');
      if (b.size > LIMIT) throw new Error('Blob 超过手机内存限制，请寻找网络原始地址');
      fallbackSave(b, `${title()}.${/webm/.test(b.type) ? 'webm' : /mp4/.test(b.type) ? 'mp4' : 'bin'}`); return;
    }
    const filename = `${title()}.${extension(item)}`;
    if (typeof GM_download === 'function') {
      say('正在交给浏览器下载…');
      try {
        await new Promise((resolve, reject) => {
          let h; const signal = t.controller.signal;
          const stop = () => { h?.abort(); clean(); reject(abortError()); };
          const clean = () => signal.removeEventListener('abort', stop);
          signal.addEventListener('abort', stop, { once: true });
          try { h = GM_download({ url: item.url, name: filename, saveAs: true, headers: { Referer: item.ref || location.href },
            onload: () => { clean(); resolve(); }, onerror: () => { clean(); reject(new Error('原生下载不可用')); }, ontimeout: () => { clean(); reject(new Error('原生下载超时')); },
            onprogress: e => say(`下载 ${sizeText(e.loaded || 0)}${e.total ? ` / ${sizeText(e.total)}` : ''}`) }); }
          catch (e) { clean(); reject(e); }
        }); say('浏览器下载完成'); return;
      } catch (e) { if (t.controller.signal.aborted) throw e; }
    }
    say('原生下载不可用，改用内存下载（最多 384 MB）');
    const r = await retry(item.url, 'blob', t, {}, item.ref);
    if (!(r.response instanceof Blob) || r.response.size > LIMIT) throw new Error('文件过大或下载响应异常，请打开链接由浏览器下载');
    if (/text\/html/.test(r.response.type)) throw new Error('返回的是网页，可能需要重新登录');
    fallbackSave(r.response, filename);
  }
  async function inspectDASH(item, t) {
    const r = await retry(item.url, 'text', t, {}, item.ref);
    const xml = new DOMParser().parseFromString(r.responseText || r.response, 'application/xml');
    if (xml.querySelector('parsererror') || !xml.querySelector('MPD')) throw new Error('不是有效 DASH 清单');
    if (xml.querySelector('ContentProtection')) throw new Error('DASH 标记为受保护内容；不提供 DRM 解密');
    const base = r.finalUrl || item.url;
    // Resolve inherited BaseURL elements; template streams remain manifests.
    for (const rep of xml.querySelectorAll('Representation')) {
      let url = base, hasBase = false;
      const chain = []; for (let n = rep; n && n.nodeType === 1; n = n.parentElement) chain.unshift(n);
      for (const n of chain) { const b = [...n.children].find(c => c.localName === 'BaseURL'); if (b) { url = absolute(b.textContent.trim(), url); hasBase = true; } }
      if (hasBase && url && !chain.some(n => [...n.children].some(c => /SegmentTemplate|SegmentList|SegmentBase/.test(c.localName))) && !url.endsWith('/'))
        add(url, 'DASH 轨道', { force: true, label: `${rep.getAttribute('height') || ''} ${rep.getAttribute('id') || '轨道'}`, mime: rep.getAttribute('mimeType') || '', ref: item.ref });
    }
    say('DASH 已检查。完整文件轨道已加入列表；模板分片流需复制清单链接用专用下载器，音视频轨道需另行合并。');
  }
  function startRecord(item) {
    try {
      if (task || recorder) throw new Error('请先完成当前任务');
      const video = players.get(item.player);
      if (!video || video.mediaKeys) throw new Error('找不到本页播放器，或播放器使用 DRM');
      const capture = video.captureStream || video.mozCaptureStream;
      if (!capture || !window.MediaRecorder) throw new Error('此手机浏览器不支持播放器录制');
      if (video.paused || video.readyState < 2) throw new Error('请先播放视频，再开始录制');
      const stream = capture.call(video);
      if (!stream.getVideoTracks().length) { stream.getTracks().forEach(t => t.stop()); throw new Error('播放器未提供可录制画面'); }
      const mime = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m));
      if (!mime) throw new Error('浏览器没有可用录制编码器');
      const rec = new MediaRecorder(stream, { mimeType: mime }), chunks = []; let bytes = 0, error = '';
      root.querySelector('.cancel').hidden = false;
      const stop = () => { if (rec.state !== 'inactive') rec.stop(); };
      video.addEventListener('ended', stop, { once: true });
      rec.ondataavailable = e => { if (e.data.size) { chunks.push(e.data); bytes += e.data.size; say(`录制中 · ${sizeText(bytes)} · 轻点停止保存`); if (bytes > LIMIT) stop(); } };
      rec.onerror = e => { error = e.error?.message || '录制失败'; stop(); };
      rec.onstop = () => { video.removeEventListener('ended', stop); stream.getTracks().forEach(tr => tr.stop()); recorder = null; root.querySelector('.cancel').hidden = true;
        if (error) say(error); else if (bytes) fallbackSave(new Blob(chunks, { type: mime }), `${title()}_录制.${mime.includes('mp4') ? 'mp4' : 'webm'}`); else say('未录到数据'); };
      try { rec.start(1000); recorder = rec; } catch (e) { stream.getTracks().forEach(tr => tr.stop()); video.removeEventListener('ended', stop); root.querySelector('.cancel').hidden = true; throw e; } say(`录制中${stream.getAudioTracks().length ? '' : '（无音轨）'} · 按播放速度保存，停止后生成文件`);
    } catch (e) { say(e.message); }
  }
  function scanPlayer(video) {
    let id = video.__liuguangPlayer;
    if (!id) { id = `p${++playerID}`; try { video.__liuguangPlayer = id; } catch {} players.set(id, video); }
    players.set(id, video);
    if (!video.__liuguangWatched) {
      try { video.__liuguangWatched = true; } catch {}
      ['loadedmetadata', 'play', 'emptied', 'durationchange'].forEach(event => video.addEventListener(event, () => scanPlayer(video)));
      video.addEventListener('encrypted', () => { const u = video.currentSrc || video.src; if (u) add(u, '受保护播放器', { force: true, player: id, drm: true }); });
    }
    const meta = { force: true, player: id, label: video.videoHeight ? `${video.videoWidth} × ${video.videoHeight}` : '', drm: Boolean(video.mediaKeys) };
    if (video.currentSrc || video.src) add(video.currentSrc || video.src, '播放器', meta);
    for (const s of video.querySelectorAll('source')) add(s.src, '播放器源', { ...meta, mime: s.type });
    if (!video.currentSrc && !video.src && video.srcObject && isTop) add(`blob:${location.origin}/liuguang-stream-${id}`, '实时播放器', meta);
  }
  function observe(scope) {
    if (observed.has(scope)) return; observed.add(scope); roots.add(scope);
    new MutationObserver(() => { if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 500); }).observe(scope, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'data-src', 'data-url', 'content'] });
  }
  function scan(deep = false) {
    for (const scope of [...roots]) {
      if (scope !== document && !scope.host?.isConnected) { roots.delete(scope); continue; }
      for (const v of scope.querySelectorAll('video,audio')) scanPlayer(v);
      for (const n of scope.querySelectorAll('source,a[href],link[href],meta[content],[data-src],[data-url],embed,object')) {
        const s = n.getAttribute('src') || n.getAttribute('href') || n.getAttribute('content') || n.getAttribute('data-src') || n.getAttribute('data-url') || n.getAttribute('data');
        if (s) add(s, '页面', { mime: n.getAttribute('type') || '' });
      }
      for (const n of scope.querySelectorAll('*')) { if (n === root?.host) continue; if (n.shadowRoot && !observed.has(n.shadowRoot)) observe(n.shadowRoot); }
      if (deep) for (const script of scope.querySelectorAll('script:not([src])')) extract(script.textContent, '页面配置');
    }
    try { for (const e of performance.getEntriesByType('resource')) add(e.name, '资源记录'); } catch {}
    for (const [id, v] of players) if (!v.isConnected) players.delete(id);
    scheduleRender();
  }
  async function inspectSmallResponse(response, base) {
    let reader;
    try {
      reader = response.clone().body?.getReader(); if (!reader) return;
      const chunks = []; let bytes = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 1500000) { reader.cancel().catch(() => {}); return; }
        chunks.push(part.value);
      }
      const merged = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
      extract(new TextDecoder().decode(merged), 'API 配置', base);
    } catch { try { reader?.cancel().catch(() => {}); } catch {} }
  }
  function hook() {
    // Page realm hooks retain original semantics and never consume original responses.
    try {
      const oldFetch = PAGE.fetch;
      PAGE.fetch = function(...args) {
        const p = Reflect.apply(oldFetch, this, args);
        try { const u = typeof args[0] === 'string' ? args[0] : args[0]?.url; if (u) add(u, 'fetch'); } catch {}
        p.then(r => {
          try {
            const mime = r.headers.get('content-type') || '', u = r.url;
            if (mimeMedia.test(mime)) add(u, 'fetch 响应', { mime, force: true });
            const length = Number(r.headers.get('content-length') || 0);
            // API responses are read with a hard cap, including chunked JSON. Video streams are never cloned.
            if (/json|javascript/.test(mime) && length < 1500000) inspectSmallResponse(r, u);
          } catch {}
        }, () => {}); return p;
      };
    } catch {}
    try {
      const proto = PAGE.XMLHttpRequest.prototype, oldOpen = proto.open;
      proto.open = function(...args) {
        try {
          const u = absolute(args[1]); add(u, 'XHR');
          this.addEventListener('load', () => {
            try { const mime = this.getResponseHeader('content-type') || '';
              add(this.responseURL || u, 'XHR 响应', { mime });
              if ((!this.responseType || this.responseType === 'text') && /json|javascript/.test(mime)) extract(this.responseText, 'API 配置', this.responseURL || u);
            } catch {}
          }, { once: true });
        } catch {}
        return Reflect.apply(oldOpen, this, args);
      };
    } catch {}
    try {
      const oldCreate = PAGE.URL.createObjectURL;
      PAGE.URL.createObjectURL = function(obj) {
        const u = Reflect.apply(oldCreate, this, [obj]);
        try { if (obj && typeof obj.size === 'number' && mimeMedia.test(obj.type)) { blobs.set(u, obj); add(u, '媒体 Blob', { force: true, mime: obj.type }); } } catch {}
        return u;
      };
      const oldRevoke = PAGE.URL.revokeObjectURL;
      PAGE.URL.revokeObjectURL = function(u) { blobs.delete(u); return Reflect.apply(oldRevoke, this, [u]); };
    } catch {}
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) add(e.name, '网络资源'); }).observe({ type: 'resource', buffered: true }); } catch {}
  }
  function render() {
    if (!root) return;
    const all = [...candidates.values()], visible = all.filter(i => i.type !== '分片');
    badge.textContent = visible.length ? String(visible.length) : '↓';
    badge.setAttribute('aria-label', `流光，发现 ${visible.length} 个媒体资源`);
    if (panel.hidden) return;
    list.replaceChildren();
    if (!visible.length) list.append(el('p', 'empty', '先播放视频，流光会在这里发现它。\n也可以轻点“扫描”读取页面配置。'));
    const order = { HLS: 0, 文件: 1, DASH: 2, BLOB: 3 };
    visible.sort((a, b) => order[a.type] - order[b.type]);
    for (const item of visible) {
      const row = el('div', 'item'), name = el('div', 'name', item.label || (item.player ? '页面视频' : item.type === 'HLS' ? '流媒体视频' : '媒体资源'));
      row.append(name);
      let host = ''; try { host = new URL(item.url).host || '本页播放器'; } catch {}
      row.append(el('div', 'meta', `${item.drm ? '受保护 · ' : ''}${item.type} · ${host} · ${item.source}`));
      const url = el('div', 'url', item.url); url.title = item.url; row.append(url);
      const actions = el('div', 'actions');
      if (!item.drm) actions.append(button(item.type === 'HLS' ? '下载' : item.type === 'DASH' ? '检查轨道' : '下载', () => run(t => item.type === 'HLS' ? loadHLS(item, t) : item.type === 'DASH' ? inspectDASH(item, t) : direct(item, t)), 'primary'));
      actions.append(button('复制', () => copy(item.url)));
      if (/^https?:/.test(item.url)) actions.append(button('打开', () => openURL(item.url)));
      if (item.player && !item.drm && players.has(item.player)) actions.append(button('录制', () => startRecord(item)));
      row.append(actions); list.append(row);
    }
    root.querySelector('.count').textContent = `${visible.length} 个资源`;
  }
  function mount() {
    if (!isTop || rendered || !document.documentElement) return;
    rendered = true;
    const host = el('div'); host.id = 'liuguang-video-tool';
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    document.documentElement.append(host); root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host{color-scheme:light dark}*{box-sizing:border-box}button,a,input{font:inherit}button{border:0;cursor:pointer;-webkit-tap-highlight-color:transparent;min-height:44px;border-radius:14px;background:var(--soft);color:var(--fg);padding:0 15px;font-weight:600}button:active{transform:scale(.97)}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #007aff;outline-offset:2px}[hidden]{display:none!important}
      .app{--bg:rgba(248,248,250,.96);--fg:#151519;--soft:#eaeaef;--muted:#72727a;--card:#fff;--line:#e5e5ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:var(--fg);pointer-events:none}
      .fab{pointer-events:auto;position:fixed;right:16px;bottom:calc(22px + env(safe-area-inset-bottom,0px));width:50px;height:50px;padding:0;border-radius:50%;background:rgba(250,250,252,.92);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);color:#007aff;box-shadow:0 4px 25px #0003;border:1px solid #ffffff70;font-size:21px}
      .shade{pointer-events:auto;position:fixed;inset:0;background:#0004}
      .panel{pointer-events:auto;position:fixed;bottom:0;right:0;left:0;margin:auto;width:min(100%,520px);max-height:88vh;max-height:88dvh;background:var(--bg);backdrop-filter:blur(30px);-webkit-backdrop-filter:blur(30px);border-radius:28px 28px 0 0;padding:10px 18px calc(16px + env(safe-area-inset-bottom,0px));box-shadow:0 -8px 60px #0002;display:flex;flex-direction:column}
      .grip{width:36px;height:5px;background:var(--muted);opacity:.35;border-radius:5px;margin:0 auto 12px}.head{display:flex;align-items:center;justify-content:space-between}.brand{font-size:24px;font-weight:750;letter-spacing:-1px}.count{font-size:12px;color:var(--muted);margin-top:3px}.close{font-size:22px;min-width:44px;padding:0;background:transparent}.toolbar{display:flex;gap:8px;margin:16px 0 10px}.toolbar button{flex:1}.primary{background:#007aff;color:white}.list{overflow:auto;overscroll-behavior:contain;min-height:50px;flex:1;max-height:50vh;-webkit-overflow-scrolling:touch}.item{background:var(--card);padding:15px;border-radius:19px;margin:10px 0;border:1px solid var(--line)}.name{font-size:16px;font-weight:650}.meta{font-size:11px;color:var(--muted);margin:5px 0;overflow-wrap:anywhere}.url{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:8px 0 12px}.actions{display:flex;gap:6px;flex-wrap:wrap}.actions button{font-size:13px;flex:1;min-width:58px;padding:0 9px}.empty{color:var(--muted);text-align:center;white-space:pre-line;line-height:1.8;padding:28px 4px}.status{font-size:12px;line-height:1.6;color:var(--muted);margin-top:10px;overflow-wrap:anywhere}.choices{display:flex;gap:6px;flex-wrap:wrap}.choices p{width:100%;margin:8px 0;font-size:12px;color:var(--muted)}.choices button{margin-top:6px}.save{display:block;padding:12px;margin-top:8px;color:#007aff;background:var(--card);border-radius:12px;overflow-wrap:anywhere;text-decoration:none}.help{font-size:12px;line-height:1.8;color:var(--muted);overflow:auto;max-height:45vh;padding:12px 2px}.input{display:flex;gap:6px;margin:8px 0}.input input{min-width:0;flex:1;border:1px solid var(--line);border-radius:13px;padding:12px;background:var(--card);color:var(--fg);font-size:16px}.cancel{color:#ff3b30;margin-top:8px}
      @media(prefers-color-scheme:dark){.app{--bg:rgba(28,28,30,.96);--fg:#f5f5f7;--soft:#38383c;--muted:#a1a1aa;--card:#242426;--line:#38383c}.fab{background:rgba(35,35,38,.94);border-color:#ffffff18;color:#409cff}.primary{background:#0a84ff}}
      @media(prefers-reduced-motion:no-preference){button{transition:transform .12s}}
    </style><div class="app"><button class="fab" aria-label="流光视频下载">↓</button><div class="shade" hidden></div><section class="panel" role="dialog" aria-label="流光视频下载" hidden><div class="grip"></div><div class="head"><div><div class="brand">流光</div><div class="count">等待视频</div></div><button class="close" aria-label="关闭">×</button></div><div class="toolbar"><button class="scan">扫描</button><button class="export">导出</button><button class="more">更多</button></div><div class="extras" hidden><div class="input"><input type="url" placeholder="粘贴视频 / m3u8 / mpd 地址" aria-label="媒体地址"><button class="add">添加</button></div><div class="help">先播放视频，再选择下载。HLS 可合并普通 TS / fMP4 与 AES-128 分片；独立音轨单独保存。DASH 支持检查完整文件轨道与导出清单，模板分片不在手机内合并。Blob 虚拟地址不能当作完整视频。录制需要浏览器支持，并按实际播放速度进行。<br>保持页面在前台。合并 / 录制上限 384 MB；大文件优先原生下载，或复制链接到专用下载器。直播仅保存当前列表快照。DRM、过期签名、登录限制和浏览器权限可能阻止下载。只下载你有权保存的内容。<br>不上传内容，不引入外部代码。导出的地址可能含访问令牌，请妥善保管。<br>v${VERSION}</div></div><div class="choices"></div><div class="list"></div><div class="status" aria-live="polite">播放后自动探测</div><button class="cancel" hidden>取消下载 / 停止录制并保存</button><div class="saves"></div></section></div>`;
    panel = root.querySelector('.panel'); list = root.querySelector('.list'); status = root.querySelector('.status'); badge = root.querySelector('.fab');
    const shade = root.querySelector('.shade');
    const toggle = (show = panel.hidden) => { panel.hidden = !show; shade.hidden = !show; if (show) { scan(); render(); root.querySelector('.close').focus(); } else badge.focus(); };
    badge.onclick = () => toggle(); root.querySelector('.close').onclick = () => toggle(false); shade.onclick = () => toggle(false);
    root.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false); });
    root.querySelector('.scan').onclick = () => { scan(true); say('扫描完成；继续播放视频可发现新的网络源'); };
    root.querySelector('.more').onclick = () => { const n = root.querySelector('.extras'); n.hidden = !n.hidden; };
    root.querySelector('.add').onclick = () => { const input = root.querySelector('input'), url = absolute(input.value); if (!/^https?:/.test(url)) return say('请输入 HTTP / HTTPS 媒体地址'); add(url, '手动添加', { force: true }); input.value = ''; say('已添加'); };
    root.querySelector('.export').onclick = () => {
      const items = [...candidates.values()].filter(i => !i.url.startsWith('blob:') && i.type !== '分片').map(({ url, type, source, ref }) => ({ url, type, source, ref }));
      fallbackSave(new Blob([JSON.stringify({ page: location.href, title: document.title, created: new Date().toISOString(), items }, null, 2)], { type: 'application/json' }), `${title()}_视频链接.json`);
    };
    root.querySelector('.cancel').onclick = cancel;
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('流光 · 打开视频下载', () => toggle(true));
    render();
  }
  hook();
  if (isTop) window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.__liuguang !== 1 || typeof d.url !== 'string' || d.url.length > 16000 || !/^https?:/.test(d.url)) return;
    // Only accept messages from descendants. Messages never trigger privileged requests.
    function descendant(w, depth = 0) { if (depth > 8) return false; try { for (let i = 0; i < w.frames.length; i++) { if (w.frames[i] === e.source || descendant(w.frames[i], depth + 1)) return true; } } catch {} return false; }
    if (!descendant(window)) return;
    add(d.url, 'iframe', { mime: typeof d.mime === 'string' ? d.mime.slice(0, 200) : '', ref: absolute(d.ref) || e.origin, force: true });
  });
  function init() { observe(document); mount(); scan(true); }
  if (document.documentElement) init(); else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); init(); } }).observe(document, { childList: true });
  document.addEventListener('DOMContentLoaded', () => { mount(); scan(true); }, { once: true });
  // Lightweight periodic fallback for SPA navigation and player properties without DOM mutations.
  setInterval(() => {
    if (document.hidden) return;
    if (location.href !== lastURL) {
      lastURL = location.href;
      if (!task && !recorder) { candidates.clear(); blobs.clear(); players.clear(); root?.querySelector('.choices').replaceChildren(); }
      scan(true);
    } else { for (const v of document.querySelectorAll('video,audio')) scanPlayer(v); }
  }, 2500);
})();
