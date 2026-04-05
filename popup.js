/**
 * Webpage Screenshot → PDF  (Browser Extension)
 * ================================================
 * - Full page scroll-and-stitch capture
 * - Auto-detect scrollable sections
 * - Auto-detect & click through tab groups
 * - Auto-expand accordions
 * - A4 paginated PDF export
 */

const SCROLL_PAUSE = 500;
const A4_RATIO = 1.4142;
const JPEG_QUALITY = 0.92;

const captureBtn = document.getElementById("captureBtn");
const statusEl = document.getElementById("status");
captureBtn.addEventListener("click", startCapture);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function updateStatus(msg) { statusEl.textContent = msg; }

async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

async function run(tabId, func, args = []) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args,
    });
    return results[0]?.result;
}

async function captureScreen() {
    return await chrome.tabs.captureVisibleTab(null, { format: "png" });
}

function loadImage(src) {
    return new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
    });
}

// ========== Injected Functions ==========

function _getPageInfo() {
    return {
        scrollHeight: document.body.scrollHeight,
        viewportHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
    };
}

function _scrollMainTo(y) { window.scrollTo(0, y); }

function _detectScrollables() {
    const r = [];
    for (const el of document.querySelectorAll("*")) {
        const s = window.getComputedStyle(el);
        if (el.scrollHeight > el.clientHeight + 10 &&
            (s.overflowY === "auto" || s.overflowY === "scroll") &&
            el.clientHeight > 50 &&
            el.tagName !== "HTML" && el.tagName !== "BODY") {
            const uid = "sc_" + r.length;
            el.setAttribute("data-scroll-uid", uid);
            r.push({ uid, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
        }
    }
    return r;
}

function _scrollElemTo(uid, y) {
    const el = document.querySelector('[data-scroll-uid="' + uid + '"]');
    if (el) el.scrollTop = y;
}

function _scrollElemIntoView(uid) {
    const el = document.querySelector('[data-scroll-uid="' + uid + '"]');
    if (el) el.scrollIntoView({ block: "start", behavior: "instant" });
}

function _getElemRect(uid) {
    const el = document.querySelector('[data-scroll-uid="' + uid + '"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 };
}

function _detectTabGroups() {
    const groups = [];
    let uid = 0;

    function reg(container, tabs) {
        if (container.getAttribute("data-tg")) return;
        if (tabs.length < 2) return;
        const id = "tg_" + uid++;
        container.setAttribute("data-tg", id);
        tabs.forEach(function (t, i) { t.setAttribute("data-tab", id + "_" + i); });
        groups.push({
            uid: id,
            tabCount: tabs.length,
            tabLabels: tabs.map(function (t) { return t.textContent.trim().substring(0, 40); }),
        });
    }

    // ARIA tabs
    var tablists = document.querySelectorAll('[role="tablist"]');
    for (var i = 0; i < tablists.length; i++) {
        var tabs = tablists[i].querySelectorAll('[role="tab"]');
        reg(tablists[i], Array.from(tabs));
    }

    // CSS class patterns
    var sel = ".nav-tabs,.tab-list,.tabs-header";
    var containers = document.querySelectorAll(sel);
    for (var i = 0; i < containers.length; i++) {
        var kids = Array.from(containers[i].children).filter(function (c) {
            return c.tagName === "BUTTON" || c.tagName === "A" || c.tagName === "LI";
        });
        reg(containers[i], kids);
    }

    // Heuristic
    var divs = document.querySelectorAll("div, nav, ul");
    for (var i = 0; i < divs.length; i++) {
        var d = divs[i];
        if (d.getAttribute("data-tg")) continue;
        var kids = Array.from(d.children);
        var btns = kids.filter(function (c) {
            return (c.tagName === "BUTTON" || c.tagName === "A" || c.tagName === "LI") && c.offsetHeight > 0;
        });
        if (btns.length >= 2 && btns.length <= 10 && btns.length >= kids.length * 0.7) {
            var hasActive = btns.some(function (c) {
                return c.getAttribute("aria-selected") === "true" ||
                    c.classList.contains("active") || c.classList.contains("selected");
            });
            if (hasActive) reg(d, btns);
        }
    }

    return groups;
}

function _clickTab(groupUid, tabIndex) {
    var el = document.querySelector('[data-tab="' + groupUid + '_' + tabIndex + '"]');
    if (!el) return false;
    var inner = el.querySelector("a, button");
    if (inner) inner.click(); else el.click();
    return true;
}

function _getTabRegion(groupUid) {
    var tl = document.querySelector('[data-tg="' + groupUid + '"]');
    if (!tl) return null;
    tl.scrollIntoView({ block: "start", behavior: "instant" });

    var panel = null;
    var active = tl.querySelector('[aria-selected="true"], .active, .selected');
    if (active) {
        var pid = active.getAttribute("aria-controls");
        if (pid) panel = document.getElementById(pid);
    }
    if (!panel) {
        var sib = tl.nextElementSibling;
        while (sib && sib.offsetHeight < 10) sib = sib.nextElementSibling;
        panel = sib;
    }

    var tr = tl.getBoundingClientRect();
    var top = tr.top, left = tr.left, right = tr.right, bottom = tr.bottom;
    if (panel) {
        var pr = panel.getBoundingClientRect();
        top = Math.min(top, pr.top);
        left = Math.min(left, pr.left);
        right = Math.max(right, pr.right);
        bottom = Math.max(bottom, pr.bottom);
    }
    return { top: top, left: left, width: right - left, height: bottom - top, dpr: window.devicePixelRatio || 1 };
}

function _expandAccordions() {
    var n = 0;
    var details = document.querySelectorAll("details:not([open])");
    for (var i = 0; i < details.length; i++) { details[i].setAttribute("open", ""); n++; }
    var btns = document.querySelectorAll('[aria-expanded="false"]');
    for (var i = 0; i < btns.length; i++) { btns[i].click(); n++; }
    return n;
}

// ========== Capture Functions ==========

async function captureMainPage(tabId, pageInfo) {
    var sh = pageInfo.scrollHeight, vh = pageInfo.viewportHeight, dpr = pageInfo.dpr;
    await run(tabId, _scrollMainTo, [0]);
    await sleep(SCROLL_PAUSE);

    var caps = [], y = 0;
    while (y < sh) {
        await run(tabId, _scrollMainTo, [y]);
        await sleep(SCROLL_PAUSE);
        var img = await loadImage(await captureScreen());
        caps.push({ img: img, isLast: y + vh >= sh });
        y += vh;
    }

    var pw = caps[0].img.width, pvh = caps[0].img.height, th = Math.round(sh * dpr);
    var c = document.createElement("canvas");
    c.width = pw; c.height = th;
    var ctx = c.getContext("2d");

    var dy = 0;
    for (var i = 0; i < caps.length; i++) {
        var img = caps[i].img;
        if (caps[i].isLast && i > 0) {
            var rem = th - dy;
            ctx.drawImage(img, 0, Math.max(0, img.height - rem), img.width, rem, 0, dy, img.width, rem);
        } else {
            var h = Math.min(pvh, th - dy);
            ctx.drawImage(img, 0, 0, img.width, h, 0, dy, img.width, h);
            dy += h;
        }
    }
    return c;
}

async function captureScrollable(tabId, info, pageInfo) {
    var uid = info.uid, sh = info.scrollHeight, ch = info.clientHeight, dpr = pageInfo.dpr;
    await run(tabId, _scrollElemIntoView, [uid]);
    await sleep(SCROLL_PAUSE);
    await run(tabId, _scrollElemTo, [uid, 0]);
    await sleep(SCROLL_PAUSE);

    var caps = [], y = 0;
    while (y < sh) {
        await run(tabId, _scrollElemTo, [uid, y]);
        await sleep(SCROLL_PAUSE);
        var rect = await run(tabId, _getElemRect, [uid]);
        if (!rect) return null;
        var full = await loadImage(await captureScreen());
        var cx = Math.round(rect.left * dpr), cy = Math.round(rect.top * dpr);
        var cw = Math.round(rect.width * dpr), cch = Math.round(rect.height * dpr);
        var crop = document.createElement("canvas");
        crop.width = cw; crop.height = cch;
        crop.getContext("2d").drawImage(full, cx, cy, cw, cch, 0, 0, cw, cch);
        caps.push({ canvas: crop, isLast: y + ch >= sh });
        y += ch;
    }
    if (!caps.length) return null;

    var ew = caps[0].canvas.width, th = Math.round(sh * dpr);
    var c = document.createElement("canvas");
    c.width = ew; c.height = th;
    var ctx = c.getContext("2d");
    var dy = 0;
    for (var i = 0; i < caps.length; i++) {
        var cap = caps[i].canvas;
        if (caps[i].isLast && i > 0) {
            var rem = th - dy, sy = cap.height - rem;
            if (rem > 0 && sy >= 0) ctx.drawImage(cap, 0, sy, cap.width, rem, 0, dy, cap.width, rem);
        } else {
            var h = Math.min(cap.height, th - dy);
            ctx.drawImage(cap, 0, 0, cap.width, h, 0, dy, cap.width, h);
            dy += h;
        }
    }
    return c;
}

async function captureTabGroup(tabId, group, pageInfo) {
    var dpr = pageInfo.dpr, LH = 40, caps = [];

    for (var t = 0; t < group.tabCount; t++) {
        await run(tabId, _clickTab, [group.uid, t]);
        await sleep(SCROLL_PAUSE + 300);
        var rect = await run(tabId, _getTabRegion, [group.uid]);
        if (!rect) continue;
        await sleep(200);
        var fr = await run(tabId, _getTabRegion, [group.uid]);
        if (!fr) continue;

        var full = await loadImage(await captureScreen());
        var cx = Math.round(Math.max(0, fr.left) * dpr);
        var cy = Math.round(Math.max(0, fr.top) * dpr);
        var cw = Math.round(fr.width * dpr), ch = Math.round(fr.height * dpr);
        var sw = Math.min(cw, full.width - cx), sh = Math.min(ch, full.height - cy);
        if (sw <= 0 || sh <= 0) continue;

        var crop = document.createElement("canvas");
        crop.width = sw; crop.height = sh;
        crop.getContext("2d").drawImage(full, cx, cy, sw, sh, 0, 0, sw, sh);
        caps.push({ canvas: crop, label: group.tabLabels[t] || "Tab " + (t + 1) });
    }
    if (!caps.length) return null;

    var maxW = 0;
    for (var i = 0; i < caps.length; i++) { if (caps[i].canvas.width > maxW) maxW = caps[i].canvas.width; }
    var totalH = 0;
    for (var i = 0; i < caps.length; i++) { totalH += LH + caps[i].canvas.height; }

    var c = document.createElement("canvas");
    c.width = maxW; c.height = totalH;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, maxW, totalH);

    var y = 0;
    for (var i = 0; i < caps.length; i++) {
        ctx.fillStyle = "#334155";
        ctx.fillRect(0, y, maxW, LH);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 20px sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText("▸ " + caps[i].label, 16, y + LH / 2);
        y += LH;
        ctx.drawImage(caps[i].canvas, 0, y);
        y += caps[i].canvas.height;
    }
    return c;
}

// ========== PDF ==========

function normalize(canvas, tw) {
    if (canvas.width === tw) return canvas;
    var s = tw / canvas.width;
    var r = document.createElement("canvas");
    r.width = tw; r.height = Math.round(canvas.height * s);
    r.getContext("2d").drawImage(canvas, 0, 0, tw, r.height);
    return r;
}

function paginate(canvas) {
    var ph = Math.round(canvas.width * A4_RATIO), pages = [], y = 0;
    while (y < canvas.height) {
        var ch = Math.min(ph, canvas.height - y);
        var p = document.createElement("canvas");
        p.width = canvas.width; p.height = ph;
        var ctx = p.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, p.width, p.height);
        ctx.drawImage(canvas, 0, y, canvas.width, ch, 0, 0, canvas.width, ch);
        pages.push(p);
        y += ph;
    }
    return pages;
}

function makePDF(pages) {
    var w = pages[0].width, h = pages[0].height;
    var pdf = new jspdf.jsPDF({
        orientation: w > h ? "l" : "p",
        unit: "px", format: [w, h], hotfixes: ["px_scaling"],
    });
    pdf.addImage(pages[0].toDataURL("image/jpeg", JPEG_QUALITY), "JPEG", 0, 0, w, h);
    for (var i = 1; i < pages.length; i++) {
        pdf.addPage([w, h]);
        pdf.addImage(pages[i].toDataURL("image/jpeg", JPEG_QUALITY), "JPEG", 0, 0, w, h);
    }
    var d = new Date();
    var ts = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") +
        String(d.getDate()).padStart(2, "0") + "_" +
        String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0");
    pdf.save("webpage_capture_" + ts + ".pdf");
}

// ========== Main ==========

async function startCapture() {
    captureBtn.disabled = true;
    try {
        var tab = await getCurrentTab();
        var pageInfo = await run(tab.id, _getPageInfo);
        var all = [];

        updateStatus("📂 Expanding collapsed sections...");
        var expanded = await run(tab.id, _expandAccordions);
        if (expanded > 0) {
            await sleep(800);
            pageInfo = await run(tab.id, _getPageInfo);
        }

        updateStatus("🔍 Detecting...");
        var scrollables = await run(tab.id, _detectScrollables);
        var tabGroups = await run(tab.id, _detectTabGroups);
        console.log("Detected:", { scrollables: scrollables, tabGroups: tabGroups, pageInfo: pageInfo });
        updateStatus("✅ Found: " + scrollables.length + " scrollable, " + tabGroups.length + " tab group(s)");
        await sleep(300);

        updateStatus("📸 Capturing main page...");
        all.push(await captureMainPage(tab.id, pageInfo));

        for (var i = 0; i < scrollables.length; i++) {
            updateStatus("📸 Scrollable " + (i + 1) + "/" + scrollables.length);
            var c = await captureScrollable(tab.id, scrollables[i], pageInfo);
            if (c) all.push(c);
        }

        for (var g = 0; g < tabGroups.length; g++) {
            updateStatus("🔀 Tabs " + (g + 1) + "/" + tabGroups.length + ": " + tabGroups[g].tabLabels.join(" | "));
            var c = await captureTabGroup(tab.id, tabGroups[g], pageInfo);
            if (c) all.push(c);
        }

        updateStatus("📄 Paginating...");
        var tw = all[0].width, pages = [];
        for (var i = 0; i < all.length; i++) {
            var p = paginate(normalize(all[i], tw));
            for (var j = 0; j < p.length; j++) pages.push(p[j]);
        }

        updateStatus("📄 Generating PDF (" + pages.length + " pages)...");
        makePDF(pages);
        updateStatus("🎉 Done! PDF downloaded (" + pages.length + " pages)");
    } catch (err) {
        updateStatus("❌ Error: " + err.message);
        console.error(err);
    } finally {
        captureBtn.disabled = false;
    }
}