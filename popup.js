/**
 * Webpage Screenshot → PDF  (Browser Extension)
 * ================================================
 * Features:
 *   - Full page scroll-and-stitch capture
 *   - Auto-detect independently scrollable sections
 *   - ✨ Auto-detect tab groups → click each tab → capture each state
 *   - ✨ Auto-expand accordion/collapsible sections
 *   - Split into A4 pages → export as PDF
 */

// ================================================================
// Configuration
// ================================================================
const SCROLL_PAUSE = 500;
const A4_RATIO = 1.4142;
const JPEG_QUALITY = 0.92;

// ================================================================
// UI Bindings
// ================================================================
const captureBtn = document.getElementById("captureBtn");
const statusEl = document.getElementById("status");
captureBtn.addEventListener("click", startCapture);

// ================================================================
// Utility Functions
// ================================================================

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateStatus(msg) {
    statusEl.textContent = msg;
}

async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

async function execInPage(tabId, func, args = []) {
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

function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
    });
}

// ================================================================
// Injected Page Functions — Scrollable Section Detection
// ================================================================

function _detectScrollables() {
    const results = [];
    for (const el of document.querySelectorAll("*")) {
        const style = window.getComputedStyle(el);
        const oy = style.overflowY;
        if (
            el.scrollHeight > el.clientHeight + 10 &&
            (oy === "auto" || oy === "scroll") &&
            el.clientHeight > 50 &&
            el.tagName !== "HTML" &&
            el.tagName !== "BODY"
        ) {
            const uid = "sc_" + results.length;
            el.setAttribute("data-scroll-uid", uid);
            results.push({
                uid,
                tag: el.tagName,
                id: el.id || "",
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
            });
        }
    }
    return results;
}

function _getPageInfo() {
    return {
        scrollHeight: document.body.scrollHeight,
        viewportHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
    };
}

function _scrollMainTo(y) {
    window.scrollTo(0, y);
}

function _scrollElementTo(uid, y) {
    const el = document.querySelector(`[data-scroll-uid="${uid}"]`);
    if (el) el.scrollTop = y;
}

function _scrollElementIntoView(uid) {
    const el = document.querySelector(`[data-scroll-uid="${uid}"]`);
    if (el) el.scrollIntoView({ block: "start", behavior: "instant" });
}

function _getElementRect(uid) {
    const el = document.querySelector(`[data-scroll-uid="${uid}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
        top: r.top, left: r.left,
        width: r.width, height: r.height,
        dpr: window.devicePixelRatio || 1,
    };
}

// ================================================================
// ✨ NEW — Injected Page Functions — Tab Group Detection & Interaction
// ================================================================

/**
 * [Injected] Scans the page for tab-style UI components.
 *
 * Detection strategies (in priority order):
 *   1. ARIA standard: [role="tablist"] containing [role="tab"] elements
 *   2. Common CSS frameworks: .nav-tabs, .tab-list, [class*="tabs"]
 *   3. Heuristic: a row of buttons/links where one is visually "active"
 *      and clicking them toggles sibling content panels
 *
 * Each detected tab group is tagged with data-tabgroup-uid for later reference.
 */
function _detectTabGroups() {
    const groups = [];
    let uid = 0;

    // Helper: check if an element group looks like tabs
    function registerTabGroup(container, tabs) {
        if (container.getAttribute("data-tabgroup-uid")) return; // already found
        if (tabs.length < 2) return; // need at least 2 tabs

        const id = "tg_" + uid++;
        container.setAttribute("data-tabgroup-uid", id);

        // Tag each tab button so we can find it later
        tabs.forEach((tab, i) => {
            tab.setAttribute("data-tab-uid", id + "_" + i);
        });

        groups.push({
            uid: id,
            tabCount: tabs.length,
            tabLabels: tabs.map((t) => t.textContent.trim().substring(0, 40)),
        });
    }

    // --- Strategy 1: ARIA role="tablist" ---
    document.querySelectorAll('[role="tablist"]').forEach((tablist) => {
        const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
        registerTabGroup(tablist, tabs);
    });

    // --- Strategy 2: Common CSS class patterns ---
    const cssSelectors = [
        ".nav-tabs",
        ".tab-list",
        ".tabs-header",
        '[class*="tablist"]',
        '[class*="tab-nav"]',
        '[class*="tab-header"]',
        '[class*="tab-buttons"]',
    ];
    document.querySelectorAll(cssSelectors.join(",")).forEach((container) => {
        const tabs = Array.from(container.children).filter(
            (c) =>
                c.tagName === "BUTTON" ||
                c.tagName === "A" ||
                c.tagName === "LI" ||
                c.getAttribute("role") === "tab" ||
                /tab/i.test(c.className)
        );
        registerTabGroup(container, tabs);
    });

    // --- Strategy 3: Heuristic — look for button groups that behave like tabs ---
    // Find groups of adjacent buttons/links where exactly one has an "active" state
    document.querySelectorAll("div, nav, ul, section").forEach((container) => {
        if (container.getAttribute("data-tabgroup-uid")) return;

        const children = Array.from(container.children);
        // All children should be clickable elements
        const clickables = children.filter(
            (c) =>
                (c.tagName === "BUTTON" || c.tagName === "A" || c.tagName === "LI") &&
                c.offsetHeight > 0
        );

        // Must be 2-10 clickable items, and they make up most of the container's children
        if (
            clickables.length >= 2 &&
            clickables.length <= 10 &&
            clickables.length >= children.length * 0.7
        ) {
            // Check if one looks "active" (different background, aria-selected, or active class)
            const hasActive = clickables.some(
                (c) =>
                    c.getAttribute("aria-selected") === "true" ||
                    c.classList.contains("active") ||
                    c.classList.contains("selected") ||
                    c.classList.contains("current")
            );
            if (hasActive) {
                registerTabGroup(container, clickables);
            }
        }
    });

    return groups;
}

/**
 * [Injected] Clicks a specific tab within a tab group.
 * After clicking, the associated content panel should update.
 *
 * @param {string} groupUid - The tab group's unique identifier
 * @param {number} tabIndex - Zero-based index of the tab to click
 * @returns {boolean} Whether the click was successful
 */
function _clickTab(groupUid, tabIndex) {
    const tabEl = document.querySelector(
        `[data-tab-uid="${groupUid}_${tabIndex}"]`
    );
    if (!tabEl) return false;

    // Some tab implementations use <li> with an <a> or <button> inside
    const inner = tabEl.querySelector("a, button");
    if (inner) {
        inner.click();
    } else {
        tabEl.click();
    }
    return true;
}

/**
 * [Injected] Scrolls a tab group into the viewport and returns the bounding
 * rectangle of the tab header + its content panel combined.
 *
 * Finding the content panel:
 *   1. ARIA: active tab has aria-controls pointing to the panel's ID
 *   2. Sibling: the next sibling element after the tab header container
 *   3. Parent: the parent element minus the tab header
 */
function _getTabGroupRegion(groupUid) {
    const tablist = document.querySelector(
        `[data-tabgroup-uid="${groupUid}"]`
    );
    if (!tablist) return null;

    // Scroll into view
    tablist.scrollIntoView({ block: "start", behavior: "instant" });

    // Find the content panel
    let panel = null;

    // Method 1: ARIA aria-controls
    const activeTab = tablist.querySelector(
        '[aria-selected="true"], .active, .selected'
    );
    if (activeTab) {
        const panelId = activeTab.getAttribute("aria-controls");
        if (panelId) panel = document.getElementById(panelId);
    }

    // Method 2: next sibling element
    if (!panel) {
        let sibling = tablist.nextElementSibling;
        // Skip tiny/invisible elements
        while (sibling && sibling.offsetHeight < 10) {
            sibling = sibling.nextElementSibling;
        }
        if (sibling) panel = sibling;
    }

    // Calculate combined bounding rect
    const tabRect = tablist.getBoundingClientRect();
    let top = tabRect.top;
    let left = tabRect.left;
    let right = tabRect.right;
    let bottom = tabRect.bottom;

    if (panel) {
        const panelRect = panel.getBoundingClientRect();
        top = Math.min(top, panelRect.top);
        left = Math.min(left, panelRect.left);
        right = Math.max(right, panelRect.right);
        bottom = Math.max(bottom, panelRect.bottom);
    }

    const dpr = window.devicePixelRatio || 1;
    return {
        top: top,
        left: left,
        width: right - left,
        height: bottom - top,
        dpr,
    };
}

// ================================================================
// ✨ NEW — Injected Page Functions — Accordion Expansion
// ================================================================

/**
 * [Injected] Finds and expands all collapsed accordion/collapsible sections.
 * This ensures hidden content is visible before the main page capture.
 *
 * Detection targets:
 *   - [aria-expanded="false"] buttons
 *   - .accordion-button.collapsed (Bootstrap)
 *   - details:not([open]) (HTML5 native)
 *   - Common LMS collapsible patterns
 *
 * Returns the number of items expanded.
 */
function _expandAllAccordions() {
    let expanded = 0;

    // HTML5 <details> elements
    document.querySelectorAll("details:not([open])").forEach((el) => {
        el.setAttribute("open", "");
        expanded++;
    });

    // ARIA expanded="false" buttons
    document.querySelectorAll('[aria-expanded="false"]').forEach((el) => {
        el.click();
        expanded++;
    });

    // Bootstrap collapsed accordions
    document
        .querySelectorAll(".accordion-button.collapsed, .collapse:not(.show)")
        .forEach((el) => {
            if (el.classList.contains("accordion-button")) {
                el.click();
                expanded++;
            }
        });

    return expanded;
}

// ================================================================
// Core Capture Logic — Main Page
// ================================================================

async function captureMainPage(tabId, pageInfo) {
    const { scrollHeight, viewportHeight, dpr } = pageInfo;

    await execInPage(tabId, _scrollMainTo, [0]);
    await sleep(SCROLL_PAUSE);

    const captures = [];
    let y = 0;

    while (y < scrollHeight) {
        await execInPage(tabId, _scrollMainTo, [y]);
        await sleep(SCROLL_PAUSE);

        const dataUrl = await captureScreen();
        const img = await loadImage(dataUrl);
        captures.push({ img, isLast: y + viewportHeight >= scrollHeight });
        y += viewportHeight;
    }

    const physW = captures[0].img.width;
    const physViewH = captures[0].img.height;
    const totalPhysH = Math.round(scrollHeight * dpr);

    const canvas = document.createElement("canvas");
    canvas.width = physW;
    canvas.height = totalPhysH;
    const ctx = canvas.getContext("2d");

    let drawY = 0;
    for (let i = 0; i < captures.length; i++) {
        const { img, isLast } = captures[i];
        if (isLast && i > 0) {
            const remaining = totalPhysH - drawY;
            const srcY = img.height - remaining;
            ctx.drawImage(img, 0, Math.max(0, srcY), img.width, remaining, 0, drawY, img.width, remaining);
        } else {
            const drawH = Math.min(physViewH, totalPhysH - drawY);
            ctx.drawImage(img, 0, 0, img.width, drawH, 0, drawY, img.width, drawH);
            drawY += drawH;
        }
    }

    return canvas;
}

// ================================================================
// Core Capture Logic — Scrollable Elements
// ================================================================

async function captureScrollableElement(tabId, elemInfo, pageInfo) {
    const { uid, scrollHeight, clientHeight } = elemInfo;
    const { dpr } = pageInfo;

    await execInPage(tabId, _scrollElementIntoView, [uid]);
    await sleep(SCROLL_PAUSE);
    await execInPage(tabId, _scrollElementTo, [uid, 0]);
    await sleep(SCROLL_PAUSE);

    const captures = [];
    let y = 0;

    while (y < scrollHeight) {
        await execInPage(tabId, _scrollElementTo, [uid, y]);
        await sleep(SCROLL_PAUSE);

        const rect = await execInPage(tabId, _getElementRect, [uid]);
        if (!rect) return null;

        const dataUrl = await captureScreen();
        const fullImg = await loadImage(dataUrl);

        const cx = Math.round(rect.left * dpr);
        const cy = Math.round(rect.top * dpr);
        const cw = Math.round(rect.width * dpr);
        const ch = Math.round(rect.height * dpr);

        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = cw;
        cropCanvas.height = ch;
        cropCanvas.getContext("2d").drawImage(fullImg, cx, cy, cw, ch, 0, 0, cw, ch);

        captures.push({ canvas: cropCanvas, isLast: y + clientHeight >= scrollHeight });
        y += clientHeight;
    }

    if (captures.length === 0) return null;

    const elemW = captures[0].canvas.width;
    const totalH = Math.round(scrollHeight * dpr);

    const canvas = document.createElement("canvas");
    canvas.width = elemW;
    canvas.height = totalH;
    const ctx = canvas.getContext("2d");

    let drawY = 0;
    for (let i = 0; i < captures.length; i++) {
        const { canvas: cap, isLast } = captures[i];
        if (isLast && i > 0) {
            const remaining = totalH - drawY;
            const srcY = cap.height - remaining;
            if (remaining > 0 && srcY >= 0) {
                ctx.drawImage(cap, 0, srcY, cap.width, remaining, 0, drawY, cap.width, remaining);
            }
        } else {
            const drawH = Math.min(cap.height, totalH - drawY);
            ctx.drawImage(cap, 0, 0, cap.width, drawH, 0, drawY, cap.width, drawH);
            drawY += drawH;
        }
    }

    return canvas;
}

// ================================================================
// ✨ NEW — Core Capture Logic — Tab Groups
// ================================================================

/**
 * Captures every tab state within a single tab group.
 *
 * For each tab:
 *   1. Click the tab to activate it
 *   2. Wait for content to render
 *   3. Capture the viewport and crop the tab group region
 *      (tab header + content panel)
 *
 * Returns an array of canvases — one per tab.
 *
 * @param {number} tabId - Target browser tab ID
 * @param {Object} group - Tab group metadata from _detectTabGroups()
 * @param {Object} pageInfo - Page metrics
 * @returns {HTMLCanvasElement[]} Array of cropped captures, one per tab
 */
async function captureTabGroup(tabId, group, pageInfo) {
    const { dpr } = pageInfo;
    const captures = [];

    for (let t = 0; t < group.tabCount; t++) {
        // Click the tab
        await execInPage(tabId, _clickTab, [group.uid, t]);
        await sleep(SCROLL_PAUSE + 300); // extra wait for content transition

        // Get the combined region (tab header + content panel)
        const rect = await execInPage(tabId, _getTabGroupRegion, [group.uid]);
        if (!rect) continue;

        await sleep(200); // wait for scrollIntoView from _getTabGroupRegion

        // Re-fetch rect after scroll (position may have changed)
        const freshRect = await execInPage(tabId, _getTabGroupRegion, [group.uid]);
        if (!freshRect) continue;

        // Capture viewport
        const dataUrl = await captureScreen();
        const fullImg = await loadImage(dataUrl);

        // Crop the tab group region
        const cx = Math.round(Math.max(0, freshRect.left) * dpr);
        const cy = Math.round(Math.max(0, freshRect.top) * dpr);
        const cw = Math.round(freshRect.width * dpr);
        const ch = Math.round(freshRect.height * dpr);

        // Safety check: make sure crop is within image bounds
        const safeW = Math.min(cw, fullImg.width - cx);
        const safeH = Math.min(ch, fullImg.height - cy);

        if (safeW <= 0 || safeH <= 0) continue;

        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = safeW;
        cropCanvas.height = safeH;
        cropCanvas.getContext("2d").drawImage(
            fullImg,
            cx, cy, safeW, safeH,
            0, 0, safeW, safeH
        );

        captures.push(cropCanvas);
    }

    return captures;
}

// ================================================================
// Pagination & PDF Generation
// ================================================================

function normalizeCanvasWidth(canvas, targetWidth) {
    if (canvas.width === targetWidth) return canvas;
    const scale = targetWidth / canvas.width;
    const newHeight = Math.round(canvas.height * scale);
    const resized = document.createElement("canvas");
    resized.width = targetWidth;
    resized.height = newHeight;
    resized.getContext("2d").drawImage(canvas, 0, 0, targetWidth, newHeight);
    return resized;
}

function splitCanvasIntoPages(canvas) {
    const pageH = Math.round(canvas.width * A4_RATIO);
    const pages = [];
    let y = 0;

    while (y < canvas.height) {
        const contentH = Math.min(pageH, canvas.height - y);
        const page = document.createElement("canvas");
        page.width = canvas.width;
        page.height = pageH;
        const ctx = page.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, page.width, page.height);
        ctx.drawImage(canvas, 0, y, canvas.width, contentH, 0, 0, canvas.width, contentH);
        pages.push(page);
        y += pageH;
    }

    return pages;
}

function generatePDF(pageCanvases) {
    const pw = pageCanvases[0].width;
    const ph = pageCanvases[0].height;

    const pdf = new jspdf.jsPDF({
        orientation: pw > ph ? "l" : "p",
        unit: "px",
        format: [pw, ph],
        hotfixes: ["px_scaling"],
    });

    pdf.addImage(
        pageCanvases[0].toDataURL("image/jpeg", JPEG_QUALITY),
        "JPEG", 0, 0, pw, ph
    );

    for (let i = 1; i < pageCanvases.length; i++) {
        pdf.addPage([pw, ph]);
        pdf.addImage(
            pageCanvases[i].toDataURL("image/jpeg", JPEG_QUALITY),
            "JPEG", 0, 0, pw, ph
        );
    }

    const now = new Date();
    const ts = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        "_",
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
    ].join("");

    pdf.save(`webpage_capture_${ts}.pdf`);
}

// ================================================================
// Main Capture Flow
// ================================================================

async function startCapture() {
    captureBtn.disabled = true;

    try {
        const tab = await getCurrentTab();
        const pageInfo = await execInPage(tab.id, _getPageInfo);
        const allSections = [];

        // ✨ Step 1: Expand all accordions/collapsibles FIRST
        // (so their content is visible during the main page capture)
        updateStatus("📂 Expanding collapsed sections...");
        const expandedCount = await execInPage(tab.id, _expandAllAccordions);
        if (expandedCount > 0) {
            updateStatus(`📂 Expanded ${expandedCount} section(s)`);
            await sleep(800); // wait for animations to finish
            // Re-fetch page info since expanding may change page height
            const updatedInfo = await execInPage(tab.id, _getPageInfo);
            pageInfo.scrollHeight = updatedInfo.scrollHeight;
        }

        // Step 2: Detect scrollable sections
        updateStatus("🔍 Detecting scrollable sections...");
        const scrollables = await execInPage(tab.id, _detectScrollables);

        // ✨ Step 3: Detect tab groups
        updateStatus("🔍 Detecting interactive tabs...");
        const tabGroups = await execInPage(tab.id, _detectTabGroups);
        updateStatus(
            `✅ Found: ${scrollables.length} scrollable, ${tabGroups.length} tab group(s)`
        );
        await sleep(300);

        // Step 4: Capture main page
        updateStatus("📸 Capturing main page...");
        const mainCanvas = await captureMainPage(tab.id, pageInfo);
        allSections.push(mainCanvas);

        // Step 5: Capture scrollable elements
        for (let i = 0; i < scrollables.length; i++) {
            const s = scrollables[i];
            updateStatus(
                `📸 Scrollable section ${i + 1}/${scrollables.length}...`
            );
            const elemCanvas = await captureScrollableElement(tab.id, s, pageInfo);
            if (elemCanvas) allSections.push(elemCanvas);
        }

        // ✨ Step 6: Capture each tab group
        for (let g = 0; g < tabGroups.length; g++) {
            const group = tabGroups[g];
            updateStatus(
                `🔀 Tab group ${g + 1}/${tabGroups.length}: ${group.tabLabels.join(" | ")}`
            );

            const tabCaptures = await captureTabGroup(tab.id, group, pageInfo);

            for (const cap of tabCaptures) {
                allSections.push(cap);
            }
        }

        // Step 7: Normalize widths and split into A4 pages
        updateStatus("📄 Paginating...");
        const targetWidth = mainCanvas.width;
        const allPages = [];
        for (const canvas of allSections) {
            const normalized = normalizeCanvasWidth(canvas, targetWidth);
            allPages.push(...splitCanvasIntoPages(normalized));
        }

        // Step 8: Generate PDF
        updateStatus(`📄 Generating PDF (${allPages.length} pages)...`);
        generatePDF(allPages);

        updateStatus(`🎉 Done! PDF downloaded (${allPages.length} pages)`);
    } catch (err) {
        updateStatus(`❌ Error: ${err.message}`);
        console.error(err);
    } finally {
        captureBtn.disabled = false;
    }
}