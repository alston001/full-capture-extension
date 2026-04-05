/**
 * Webpage Screenshot → PDF  (Browser Extension)
 * ================================================
 * Automatically detects scrollable sections within a webpage,
 * captures their full content via scroll-and-stitch, splits
 * long captures into A4-ratio pages, and exports as a single PDF.
 *
 * Architecture:
 *   popup.js  — orchestrates the capture flow (this file)
 *   chrome.scripting.executeScript — injects helper functions into the target page
 *   chrome.tabs.captureVisibleTab  — captures the visible viewport as a PNG
 *   jsPDF — assembles the final PDF from captured page images
 */

// ================================================================
// Configuration
// ================================================================
const SCROLL_PAUSE = 500;   // ms to wait after each scroll for content to render
const A4_RATIO = 1.4142;    // height / width ratio of A4 paper (297mm / 210mm)
const JPEG_QUALITY = 0.92;  // JPEG quality for PDF images (0–1, higher = sharper but larger)

// ================================================================
// UI Bindings
// ================================================================
const captureBtn = document.getElementById("captureBtn");
const statusEl = document.getElementById("status");

captureBtn.addEventListener("click", startCapture);

// ================================================================
// Utility Functions
// ================================================================

/** Returns a Promise that resolves after the given number of milliseconds. */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Updates the status text shown in the popup UI. */
function updateStatus(msg) {
    statusEl.textContent = msg;
}

/** Queries the browser for the currently active tab and returns it. */
async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    return tab;
}

/**
 * Executes a function inside the target webpage's context.
 *
 * Why is this needed?
 * The popup runs in its own isolated environment and cannot directly
 * access the webpage's DOM. chrome.scripting.executeScript injects
 * the given function into the page so it can read/manipulate elements.
 *
 * @param {number} tabId - The ID of the tab to inject into
 * @param {Function} func - The function to execute in the page
 * @param {Array} args - Arguments to pass to the function
 * @returns {*} The return value of the injected function
 */
async function execInPage(tabId, func, args = []) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args,
    });
    return results[0]?.result;
}

/**
 * Captures the currently visible viewport of the active tab as a PNG data URL.
 * A data URL encodes the image as a base64 string (e.g. "data:image/png;base64,..."),
 * allowing in-memory processing without writing to disk.
 */
async function captureScreen() {
    return await chrome.tabs.captureVisibleTab(null, { format: "png" });
}

/** Loads an Image object from a data URL. Returns a Promise that resolves with the Image. */
function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
    });
}

// ================================================================
// Injected Page Functions
// ================================================================
// These functions are passed to execInPage() and run INSIDE
// the target webpage — not in the popup. They have access to
// the page's DOM (document, window, elements, etc.).

/**
 * [Injected] Scans the page for independently scrollable elements.
 *
 * Detection criteria:
 *   1. scrollHeight > clientHeight + 10  → content overflows vertically
 *   2. overflow-y is 'auto' or 'scroll'  → CSS allows scrolling
 *   3. clientHeight > 50                 → ignore tiny elements
 *   4. Not <html> or <body>             → main page scroll handled separately
 *
 * Each detected element is tagged with a unique data-scroll-uid attribute
 * so we can locate it again during the capture phase.
 */
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

/** [Injected] Returns basic page metrics needed for capture calculations. */
function _getPageInfo() {
    return {
        scrollHeight: document.body.scrollHeight,
        viewportHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
    };
}

/** [Injected] Scrolls the main page to the given Y offset. */
function _scrollMainTo(y) {
    window.scrollTo(0, y);
}

/** [Injected] Scrolls a specific element (identified by uid) to the given Y offset. */
function _scrollElementTo(uid, y) {
    const el = document.querySelector(`[data-scroll-uid="${uid}"]`);
    if (el) el.scrollTop = y;
}

/** [Injected] Scrolls the page so the target element is visible in the viewport. */
function _scrollElementIntoView(uid) {
    const el = document.querySelector(`[data-scroll-uid="${uid}"]`);
    if (el) el.scrollIntoView({ block: "start", behavior: "instant" });
}

/**
 * [Injected] Returns the bounding rectangle of an element in CSS pixels,
 * along with the device pixel ratio for coordinate conversion.
 */
function _getElementRect(uid) {
    const el = document.querySelector(`[data-scroll-uid="${uid}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
        dpr: window.devicePixelRatio || 1,
    };
}

// ================================================================
// Core Capture Logic
// ================================================================

/**
 * Captures the full main page by scrolling from top to bottom.
 *
 * Strategy:
 *   1. Scroll to the top of the page
 *   2. Capture the visible viewport → move down by one viewport height → repeat
 *   3. The last capture may overlap with the previous one, so we crop
 *      the overlapping region to avoid duplicated content
 *   4. Stitch all captures onto a single tall Canvas
 *
 * @param {number} tabId - Target tab ID
 * @param {Object} pageInfo - Page metrics from _getPageInfo()
 * @returns {HTMLCanvasElement} A canvas containing the full page screenshot
 */
async function captureMainPage(tabId, pageInfo) {
    const { scrollHeight, viewportHeight, dpr } = pageInfo;

    // Reset scroll position to the top
    await execInPage(tabId, _scrollMainTo, [0]);
    await sleep(SCROLL_PAUSE);

    const captures = [];
    let y = 0;

    while (y < scrollHeight) {
        await execInPage(tabId, _scrollMainTo, [y]);
        await sleep(SCROLL_PAUSE);

        const dataUrl = await captureScreen();
        const img = await loadImage(dataUrl);

        captures.push({
            img,
            isLast: y + viewportHeight >= scrollHeight,
        });
        y += viewportHeight;
    }

    // --- Stitch captured frames onto a single canvas ---
    // Note: captureVisibleTab returns images in physical pixels (CSS px × DPR),
    // so all coordinate math must account for the device pixel ratio.
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
            // Last frame: only draw the non-overlapping bottom portion
            const remaining = totalPhysH - drawY;
            const srcY = img.height - remaining;
            ctx.drawImage(
                img,
                0, Math.max(0, srcY), img.width, remaining,
                0, drawY, img.width, remaining
            );
        } else {
            const drawH = Math.min(physViewH, totalPhysH - drawY);
            ctx.drawImage(
                img,
                0, 0, img.width, drawH,
                0, drawY, img.width, drawH
            );
            drawY += drawH;
        }
    }

    return canvas;
}

/**
 * Captures the full scrollable content of a single element.
 *
 * Strategy:
 *   1. Scroll the element into the viewport
 *   2. Reset the element's internal scroll to the top
 *   3. For each scroll position:
 *      a. Capture the full viewport screenshot
 *      b. Crop out just the element's bounding rectangle
 *   4. Handle overlap on the last frame (same logic as main page)
 *   5. Stitch all cropped frames into one tall canvas
 *
 * @param {number} tabId - Target tab ID
 * @param {Object} elemInfo - Element metadata from _detectScrollables()
 * @param {Object} pageInfo - Page metrics from _getPageInfo()
 * @returns {HTMLCanvasElement|null} Canvas with full element content, or null on failure
 */
async function captureScrollableElement(tabId, elemInfo, pageInfo) {
    const { uid, scrollHeight, clientHeight } = elemInfo;
    const { dpr } = pageInfo;

    // Bring the element into view on the main page
    await execInPage(tabId, _scrollElementIntoView, [uid]);
    await sleep(SCROLL_PAUSE);

    // Reset the element's own scroll position
    await execInPage(tabId, _scrollElementTo, [uid, 0]);
    await sleep(SCROLL_PAUSE);

    const captures = [];
    let y = 0;

    while (y < scrollHeight) {
        // Scroll the element's internal content
        await execInPage(tabId, _scrollElementTo, [uid, y]);
        await sleep(SCROLL_PAUSE);

        // Get the element's current position (may shift if main page scrolled)
        const rect = await execInPage(tabId, _getElementRect, [uid]);
        if (!rect) return null;

        // Capture the full viewport
        const dataUrl = await captureScreen();
        const fullImg = await loadImage(dataUrl);

        // Crop the element's region from the full screenshot
        // Coordinates must be converted from CSS pixels to physical pixels
        const cx = Math.round(rect.left * dpr);
        const cy = Math.round(rect.top * dpr);
        const cw = Math.round(rect.width * dpr);
        const ch = Math.round(rect.height * dpr);

        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = cw;
        cropCanvas.height = ch;
        cropCanvas.getContext("2d").drawImage(
            fullImg,
            cx, cy, cw, ch,
            0, 0, cw, ch
        );

        captures.push({
            canvas: cropCanvas,
            isLast: y + clientHeight >= scrollHeight,
        });
        y += clientHeight;
    }

    if (captures.length === 0) return null;

    // --- Stitch all cropped frames ---
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
                ctx.drawImage(
                    cap,
                    0, srcY, cap.width, remaining,
                    0, drawY, cap.width, remaining
                );
            }
        } else {
            const drawH = Math.min(cap.height, totalH - drawY);
            ctx.drawImage(
                cap,
                0, 0, cap.width, drawH,
                0, drawY, cap.width, drawH
            );
            drawY += drawH;
        }
    }

    return canvas;
}

// ================================================================
// Pagination & PDF Generation
// ================================================================

/**
 * Normalizes a canvas to a target width, scaling proportionally.
 * This ensures all captures (main page + scrollable sections) have
 * the same width before being split into pages, producing a uniform PDF.
 *
 * @param {HTMLCanvasElement} canvas - The source canvas
 * @param {number} targetWidth - Desired output width in pixels
 * @returns {HTMLCanvasElement} Resized canvas
 */
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

/**
 * Splits a tall canvas into multiple A4-sized page canvases.
 * All output pages have exactly the same dimensions (A4_WIDTH × A4_HEIGHT)
 * for a clean, uniform PDF. The last page is padded with white if shorter.
 *
 * @param {HTMLCanvasElement} canvas - Source canvas (should already be normalized to A4_WIDTH)
 * @returns {HTMLCanvasElement[]} Array of identically-sized page canvases
 */
function splitCanvasIntoPages(canvas) {
    const pageH = Math.round(canvas.width * A4_RATIO);

    const pages = [];
    let y = 0;

    while (y < canvas.height) {
        const contentH = Math.min(pageH, canvas.height - y);

        // Every page is the same size — short content gets a white background
        const page = document.createElement("canvas");
        page.width = canvas.width;
        page.height = pageH;
        const ctx = page.getContext("2d");

        // Fill with white first (for pages shorter than full A4)
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, page.width, page.height);

        // Draw the actual content
        ctx.drawImage(
            canvas,
            0, y, canvas.width, contentH,
            0, 0, canvas.width, contentH
        );

        pages.push(page);
        y += pageH;
    }

    return pages;
}

/**
 * Assembles all page canvases into a single PDF and triggers a download.
 * All pages are the same A4 dimensions for a clean, professional output.
 *
 * @param {HTMLCanvasElement[]} pageCanvases - Array of uniformly-sized page canvases
 */
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

    // Generate filename with timestamp
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

/**
 * Entry point — orchestrates the entire capture-to-PDF pipeline:
 *   1. Detect scrollable sections in the active tab
 *   2. Capture the full main page (scroll + stitch)
 *   3. Capture each scrollable section (scroll + crop + stitch)
 *   4. Split all captures into A4-ratio pages
 *   5. Generate and download the PDF
 */
async function startCapture() {
    captureBtn.disabled = true;

    try {
        const tab = await getCurrentTab();

        // Step 1: Detect scrollable sections
        updateStatus("🔍 Detecting scrollable sections...");
        const scrollables = await execInPage(tab.id, _detectScrollables);
        updateStatus(`✅ Found ${scrollables.length} scrollable section(s)`);
        await sleep(300);

        const pageInfo = await execInPage(tab.id, _getPageInfo);

        // Step 2: Capture the main page
        updateStatus("📸 Capturing main page...");
        const mainCanvas = await captureMainPage(tab.id, pageInfo);
        const allSections = [mainCanvas];

        // Step 3: Capture each scrollable section
        for (let i = 0; i < scrollables.length; i++) {
            const s = scrollables[i];
            updateStatus(
                `📸 Capturing section ${i + 1}/${scrollables.length} (${s.tag})...`
            );
            const elemCanvas = await captureScrollableElement(tab.id, s, pageInfo);
            if (elemCanvas) allSections.push(elemCanvas);
        }

        // Step 4: Normalize all captures to the same width, then split into A4 pages
        updateStatus("📄 Paginating...");
        const targetWidth = mainCanvas.width; // Use main page width as the standard
        const allPages = [];
        for (const canvas of allSections) {
            const normalized = normalizeCanvasWidth(canvas, targetWidth);
            allPages.push(...splitCanvasIntoPages(normalized));
        }

        // Step 5: Generate PDF
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