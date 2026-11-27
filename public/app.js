(() => {
  "use strict";

  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
  const CODE_LEN = 6;
  const MAX_IMAGE_CHARS = 1_400_000; // stay under the server's 1.5 MB cap
  const MAX_SIDE = 2000;

  const $ = (id) => document.getElementById(id);
  const home = $("home"), room = $("room");
  const itemsEl = $("items"), emptyEl = $("empty"), textEl = $("text");
  const statusEl = $("status");

  let code = null;
  let ws = null;
  let retry = 0;
  let pingTimer = null;
  let reconnectTimer = null;
  let ttl = 24 * 3600 * 1000;
  let peers = 0;
  const items = new Map();

  // ---------- routing ----------

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
    return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  }

  function cleanCode(s) {
    return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  }

  function route() {
    const c = cleanCode(location.hash.slice(1));
    if (c.length >= 4) enterRoom(c);
    else showHome();
  }

  function showHome() {
    leaveRoom();
    room.hidden = true;
    home.hidden = false;
    document.title = "Clipboard";
    try {
      const last = localStorage.getItem("lastRoom");
      if (last) $("join-code").value = last;
    } catch {}
  }

  function enterRoom(c) {
    if (code === c) return;
    leaveRoom();
    code = c;
    try { localStorage.setItem("lastRoom", c); } catch {}
    home.hidden = true;
    room.hidden = false;
    $("code-text").textContent = c;
    document.title = `${c} · Clipboard`;
    $("qr-panel").hidden = true;
    items.clear();
    render();
    connect();
    if (matchMedia("(pointer: fine)").matches) textEl.focus();
  }

  function leaveRoom() {
    code = null;
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  $("new-room").onclick = () => { location.hash = newCode(); };
  $("join-form").onsubmit = (e) => {
    e.preventDefault();
    const c = cleanCode($("join-code").value);
    if (c.length < 4) return toast("Enter the room code shown on your other device");
    location.hash = c;
  };
  $("join-code").oninput = (e) => { e.target.value = cleanCode(e.target.value); };
  $("leave").onclick = () => { history.pushState(null, "", location.pathname); showHome(); };
  window.addEventListener("hashchange", route);

  // ---------- connection ----------

  function setStatus(state, label) {
    statusEl.dataset.state = state;
    statusEl.lastElementChild.textContent = label;
  }

  function peersLabel() {
    const others = Math.max(0, peers - 1);
    return others === 0 ? "Only you" : others === 1 ? "1 other device" : `${others} other devices`;
  }

  function connect() {
    const myCode = code;
    setStatus("connecting", "Connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/api/room/${myCode}`);
    ws = sock;

    sock.onopen = () => {
      retry = 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(() => sock.readyState === 1 && sock.send("ping"), 25000);
    };

    sock.onmessage = (e) => {
      if (e.data === "pong") return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.type) {
        case "init":
          ttl = msg.ttl || ttl;
          items.clear();
          for (const it of msg.items) items.set(it.id, it);
          render();
          break;
        case "add":
          items.set(msg.item.id, msg.item);
          render(msg.item.id);
          break;
        case "delete":
          items.delete(msg.id);
          render();
          break;
        case "clear":
          items.clear();
          render();
          break;
        case "peers":
          peers = msg.count;
          setStatus("online", peersLabel());
          break;
        case "error":
          toast(msg.message);
          break;
      }
    };

    sock.onclose = () => {
      clearInterval(pingTimer);
      if (code !== myCode) return;
      setStatus("offline", "Reconnecting");
      const delay = Math.min(10000, 500 * 2 ** retry++);
      reconnectTimer = setTimeout(() => code === myCode && connect(), delay);
    };
  }

  // Phones suspend background tabs; reconnect as soon as the page is visible again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && code && (!ws || ws.readyState > 1)) {
      clearTimeout(reconnectTimer);
      retry = 0;
      connect();
    }
  });

  function send(obj) {
    if (!ws || ws.readyState !== 1) {
      toast("Not connected yet, try again in a second");
      return false;
    }
    ws.send(JSON.stringify(obj));
    return true;
  }

  // ---------- sending ----------

  function sendText(t) {
    if (!t || !t.trim()) return false;
    return send({ type: "add", kind: "text", data: t });
  }

  async function sendImage(file) {
    try {
      const data = await imageToDataURL(file);
      if (data.length > MAX_IMAGE_CHARS) return toast("That image is too large");
      send({ type: "add", kind: "image", data, name: file.name || "image" });
    } catch {
      toast("Couldn't read that image");
    }
  }

  function readAsDataURL(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }

  // Shrink photos so they fit comfortably; keep small images (like screenshots) untouched.
  async function imageToDataURL(file) {
    if (file.size < MAX_IMAGE_CHARS * 0.7 && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      return readAsDataURL(file);
    }
    const bmp = await loadImage(file);
    let scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    let quality = 0.85;
    for (let i = 0; i < 6; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= MAX_IMAGE_CHARS) return url;
      scale *= 0.8;
      quality = Math.max(0.6, quality - 0.05);
    }
    throw new Error("too big");
  }

  function loadImage(file) {
    if (window.createImageBitmap) return createImageBitmap(file);
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }

  $("send").onclick = () => {
    if (sendText(textEl.value)) { textEl.value = ""; autosize(); }
    textEl.focus();
  };

  textEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) {
      e.preventDefault();
      $("send").click();
    }
  });
  textEl.addEventListener("input", autosize);
  function autosize() {
    textEl.style.height = "auto";
    textEl.style.height = textEl.scrollHeight + "px";
  }

  $("file").onchange = (e) => {
    for (const f of e.target.files) sendImage(f);
    e.target.value = "";
  };

  // The Paste button reads the system clipboard directly (asks for permission on some browsers).
  $("paste-btn").onclick = async () => {
    try {
      if (navigator.clipboard.read) {
        const clip = await navigator.clipboard.read();
        for (const ci of clip) {
          const imgType = ci.types.find((t) => t.startsWith("image/"));
          if (imgType) {
            const blob = await ci.getType(imgType);
            return sendImage(new File([blob], "pasted-image", { type: imgType }));
          }
          if (ci.types.includes("text/plain")) {
            const t = await (await ci.getType("text/plain")).text();
            if (!sendText(t)) toast("Your clipboard is empty");
            return;
          }
        }
        return toast("Your clipboard is empty");
      }
      const t = await navigator.clipboard.readText();
      if (!sendText(t)) toast("Your clipboard is empty");
    } catch {
      toast("Clipboard access was blocked. Long-press the text box and choose Paste.");
    }
  };

  // Ctrl+V anywhere: images are sent right away; text is sent right away unless you're typing in the box.
  document.addEventListener("paste", (e) => {
    if (room.hidden) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      files.forEach(sendImage);
      return;
    }
    if (e.target === textEl || e.target.closest?.("input")) return;
    const t = e.clipboardData?.getData("text/plain");
    if (t) { e.preventDefault(); sendText(t); }
  });

  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("drag")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) files.forEach(sendImage);
    else sendText(e.dataTransfer.getData("text/plain"));
  });

  $("clear").onclick = () => {
    if (confirm("Remove everything in this room for all devices?")) send({ type: "clear" });
  };

  // ---------- rendering ----------

  function render(freshId) {
    const list = [...items.values()].sort((a, b) => b.at - a.at);
    itemsEl.replaceChildren(...list.map((it) => renderItem(it, it.id === freshId)));
    emptyEl.hidden = list.length > 0;
    $("clear").hidden = list.length === 0;
  }

  const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

  function linkify(el, text) {
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      let url = m[0].replace(/[.,;:!?)\]]+$/, "");
      el.append(text.slice(last, m.index));
      const a = document.createElement("a");
      a.href = url;
      a.textContent = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      el.append(a);
      last = m.index + url.length;
    }
    el.append(text.slice(last));
  }

  function btn(label, onClick, cls) {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = onClick;
    return b;
  }

  function renderItem(it, fresh) {
    const li = document.createElement("li");
    li.className = "item" + (fresh ? " fresh" : "");
    if (fresh) setTimeout(() => li.classList.remove("fresh"), 1500);

    const meta = document.createElement("div");
    meta.className = "meta";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = timeAgo(it.at);
    when.title = `Expires ${new Date(it.at + ttl).toLocaleString()}`;
    meta.append(when);

    if (it.kind === "text") {
      const body = document.createElement("div");
      body.className = "body";
      linkify(body, it.data);
      li.append(body);
      const only = it.data.trim().match(/^https?:\/\/\S+$/);
      if (only) {
        const open = document.createElement("a");
        open.href = only[0];
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        open.textContent = "Open";
        meta.append(open);
      }
      meta.append(btn("Copy", () => copyText(it.data)));
    } else {
      const img = document.createElement("img");
      img.src = it.data;
      img.alt = it.name || "Image";
      img.loading = "lazy";
      li.append(img);
      if (window.ClipboardItem && navigator.clipboard?.write) meta.append(btn("Copy", () => copyImage(it.data)));
      const save = document.createElement("a");
      save.href = it.data;
      save.download = fileName(it);
      save.textContent = "Save";
      meta.append(save);
    }
    meta.append(btn("Delete", () => send({ type: "delete", id: it.id }), "del"));
    li.append(meta);
    return li;
  }

  function fileName(it) {
    const ext = (it.data.match(/^data:image\/(\w+)/) || [, "png"])[1].replace("jpeg", "jpg");
    const base = (it.name || "image").replace(/\.[a-z0-9]+$/i, "").replace(/[^\w-]+/g, "_") || "image";
    return `${base}.${ext}`;
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      toast("Copied");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      toast(ok ? "Copied" : "Couldn't copy, select the text instead");
    }
  }

  async function copyImage(dataUrl) {
    try {
      // Browsers only accept PNG on the clipboard, so convert first.
      const png = new Promise(async (res, rej) => {
        try {
          const bmp = await loadImage(await (await fetch(dataUrl)).blob());
          const c = document.createElement("canvas");
          c.width = bmp.width;
          c.height = bmp.height;
          c.getContext("2d").drawImage(bmp, 0, 0);
          c.toBlob((b) => (b ? res(b) : rej()), "image/png");
        } catch (e) { rej(e); }
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      toast("Image copied");
    } catch {
      toast("Couldn't copy the image, use Save instead");
    }
  }

  function timeAgo(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleString();
  }
  setInterval(() => code && items.size && render(), 30000);

  // ---------- room link + QR ----------

  function roomUrl() {
    return `${location.origin}/#${code}`;
  }

  $("code-btn").onclick = async () => {
    const url = roomUrl();
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try { await navigator.share({ title: "Clipboard room", url }); return; } catch {}
    }
    copyText(url);
  };

  $("qr-btn").onclick = () => {
    const panel = $("qr-panel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      const qr = qrcode(0, "M");
      qr.addData(roomUrl());
      qr.make();
      $("qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
    }
  };

  // ---------- toast ----------

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  route();
})();
