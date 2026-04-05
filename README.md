# Full Capture Extension

A Chrome/Brave browser extension that captures **complete webpage content** — including interactive tabs, accordions, and independently scrollable sections — and exports everything as a single, paginated PDF.

## Why This Extension?

Most screenshot tools only capture what's visible or the main page scroll. They miss content hidden behind **interactive UI elements** like:

- **Tabs** — Content that requires clicking each tab to view
- **Accordions** — Collapsed sections that need to be expanded
- **Scrollable panels** — Overflow containers with their own scrollbars

This extension automatically detects and captures all of them.

## Features

- 📸 **Full page capture** — Scrolls the entire page and stitches screenshots seamlessly
- 🔀 **Tab auto-click** — Detects tab groups, clicks each tab, and captures every state
- 📂 **Accordion expansion** — Automatically expands all collapsed sections before capture
- 📜 **Scrollable section detection** — Finds and captures independently scrollable containers
- 📄 **A4 PDF output** — Splits long captures into uniform A4-ratio pages
- 🔒 **Privacy-first** — All processing happens locally in your browser. No data is sent anywhere.

## How It Works

```
1. Click the extension icon on any webpage
2. The extension automatically:
   → Expands all accordions/collapsible sections
   → Captures the full main page (scroll + stitch)
   → Detects and captures each scrollable section
   → Clicks through each tab group and captures every tab state
3. Everything is split into A4 pages and downloaded as a single PDF
```

## Installation

### From source (Developer mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/alston001/full-capture-extension.git
   ```

2. Download the jsPDF library and place it in the project folder:
   - [jspdf.umd.min.js (v3.0.3)](https://cdnjs.cloudflare.com/ajax/libs/jspdf/3.0.3/jspdf.umd.min.js) — Right-click → Save As

3. Open your browser's extension page:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`

4. Enable **Developer mode** (toggle in the top-right corner)

5. Click **Load unpacked** → Select the project folder

6. The extension icon will appear in your toolbar. Done!

## Project Structure

```
full-capture-extension/
├── manifest.json          # Extension config (permissions, metadata)
├── popup.html             # UI shown when clicking the extension icon
├── popup.js               # Core logic (detection, capture, PDF generation)
├── jspdf.umd.min.js       # PDF generation library (not included, see installation)
├── LICENSE                 # MIT License
└── README.md
```

## Technical Details

### Tab Detection Strategy

The extension uses a 3-layer detection approach to find tab UIs across different websites and frameworks:

| Priority | Method | Targets |
|----------|--------|---------|
| 1 | ARIA standard | `[role="tablist"]` + `[role="tab"]` |
| 2 | CSS class patterns | `.nav-tabs`, `.tab-list`, `[class*="tablist"]`, etc. |
| 3 | Heuristic analysis | Groups of buttons/links with an "active" state indicator |

### Capture Pipeline

1. **Expand** — Auto-expand all accordions (`aria-expanded`, `<details>`, Bootstrap)
2. **Detect** — Scan DOM for scrollable sections and tab groups
3. **Capture main page** — Scroll viewport, capture at each position, stitch vertically
4. **Capture scrollable sections** — For each detected section: scroll internally, crop from viewport, stitch
5. **Capture tabs** — For each tab group: click each tab → wait for render → capture the tab region
6. **Paginate** — Normalize all captures to uniform width, split into A4-ratio pages
7. **Export** — Assemble pages into PDF via jsPDF, trigger download

### Key APIs Used

- `chrome.tabs.captureVisibleTab()` — Viewport screenshot capture
- `chrome.scripting.executeScript()` — DOM access in the target page
- Canvas API — Image cropping, stitching, and scaling
- jsPDF — PDF assembly and export

## Built With

- JavaScript (Vanilla)
- [Chrome Extensions Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
- [jsPDF](https://github.com/parallax/jsPDF) — Client-side PDF generation
- Canvas API — Image processing

## Acknowledgments

This project was built with assistance from [Claude](https://claude.ai) by Anthropic, which helped with architecture design, code implementation, and documentation.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
