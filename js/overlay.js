/**
 * ============================================================================
 * overlay.js — Solution Overlay Renderer
 * ============================================================================
 * 
 * Renders the solved digits back onto the original puzzle image at the
 * exact coordinates of each grid cell.
 * 
 * Design choices:
 * - Solved digits: cyan (#00d2ff) with dark stroke for contrast
 * - Original (given) digits: left untouched
 * - Uncertain cells: red highlight with "?" indicator
 * - Font: Inter (loaded via Google Fonts) or system sans-serif fallback
 * 
 * ============================================================================
 */

class SolutionOverlay {

    /**
     * Renders the complete solution overlay on the display canvas.
     * 
     * @param {HTMLCanvasElement} displayCanvas - The main display canvas
     * @param {HTMLImageElement|HTMLCanvasElement} originalImage - The original uploaded image
     * @param {Array<{row,col,x,y,w,h}>} gridCells - Cell positions from grid detection
     * @param {number[][]} originalGrid - The OCR-detected grid (0 = empty)
     * @param {number[][]} solvedGrid - The solved grid (all cells filled)
     * @param {Array} uncertainCells - Cells flagged as uncertain by OCR
     * @param {Object} [options] - Rendering options
     */
    static render(displayCanvas, originalImage, gridCells, originalGrid, solvedGrid, uncertainCells = [], options = {}) {
        const {
            solvedColor = '#d97757',      // Clay for solved digits
            givenColor = null,             // null = don't redraw given digits
            uncertainColor = '#c6613f',    // Clay Deep for uncertain cells
            strokeColor = '#faf9f5',       // Ivory Light outline
            strokeWidth = 3,
            fontFamily = "'Lora', 'Georgia', serif",
            fontSizeRatio = 0.55,          // Font size relative to cell height
            showAnimation = true
        } = options;

        const ctx = displayCanvas.getContext('2d');
        
        // Set canvas size to match original image
        displayCanvas.width = originalImage.naturalWidth || originalImage.width;
        displayCanvas.height = originalImage.naturalHeight || originalImage.height;

        // Draw the original image as background
        ctx.drawImage(originalImage, 0, 0, displayCanvas.width, displayCanvas.height);

        // Create a set of uncertain cell positions for quick lookup
        const uncertainSet = new Set(
            uncertainCells.map(c => `${c.row},${c.col}`)
        );

        // Build cell lookup map
        const cellMap = new Map();
        for (const cell of gridCells) {
            cellMap.set(`${cell.row},${cell.col}`, cell);
        }

        // Render each solved digit
        for (let r = 0; r < 6; r++) {
            for (let c = 0; c < 6; c++) {
                const key = `${r},${c}`;
                const cell = cellMap.get(key);
                if (!cell) continue;

                const wasEmpty = originalGrid[r][c] === 0;
                const isUncertain = uncertainSet.has(key);

                if (wasEmpty && solvedGrid[r][c] !== 0) {
                    // This cell was solved — draw the digit
                    const digit = solvedGrid[r][c];
                    const fontSize = Math.round(cell.h * fontSizeRatio);
                    const centerX = cell.x + cell.w / 2;
                    const centerY = cell.y + cell.h / 2;

                    // Semi-transparent background overlay for solved cells
                    ctx.fillStyle = 'rgba(217, 119, 87, 0.08)';
                    ctx.fillRect(cell.x + 2, cell.y + 2, cell.w - 4, cell.h - 4);

                    // Draw the digit with stroke for readability
                    ctx.font = `bold ${fontSize}px ${fontFamily}`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';

                    // Dark outline (stroke)
                    ctx.strokeStyle = strokeColor;
                    ctx.lineWidth = strokeWidth;
                    ctx.lineJoin = 'round';
                    ctx.strokeText(String(digit), centerX, centerY);

                    // Filled digit
                    ctx.fillStyle = solvedColor;
                    ctx.fillText(String(digit), centerX, centerY);
                }

                if (isUncertain) {
                    // Highlight uncertain cell with red border
                    ctx.strokeStyle = uncertainColor;
                    ctx.lineWidth = 2;
                    ctx.setLineDash([4, 4]);
                    ctx.strokeRect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);
                    ctx.setLineDash([]);

                    // Warm highlight overlay
                    ctx.fillStyle = 'rgba(245, 227, 199, 0.4)';
                    ctx.fillRect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);
                }
            }
        }
    }

    /**
     * Renders just the detected grid overlay (for debugging/preview).
     * Shows the detected grid lines on top of the original image.
     * 
     * @param {HTMLCanvasElement} canvas - Target canvas
     * @param {HTMLImageElement|HTMLCanvasElement} image - Original image
     * @param {number[]} hLines - Horizontal line positions
     * @param {number[]} vLines - Vertical line positions
     */
    static renderGridOverlay(canvas, image, hLines, vLines) {
        const ctx = canvas.getContext('2d');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        ctx.strokeStyle = 'rgba(20, 20, 19, 0.7)';
        ctx.lineWidth = 2;

        // Draw horizontal lines
        const minX = vLines[0] || 0;
        const maxX = vLines[vLines.length - 1] || canvas.width;
        for (const y of hLines) {
            ctx.beginPath();
            ctx.moveTo(minX, y);
            ctx.lineTo(maxX, y);
            ctx.stroke();
        }

        // Draw vertical lines
        const minY = hLines[0] || 0;
        const maxY = hLines[hLines.length - 1] || canvas.height;
        for (const x of vLines) {
            ctx.beginPath();
            ctx.moveTo(x, minY);
            ctx.lineTo(x, maxY);
            ctx.stroke();
        }
    }

    /**
     * Creates a downloadable image of the solved puzzle.
     * 
     * @param {HTMLCanvasElement} canvas - The rendered solution canvas
     * @param {string} filename - Download filename
     */
    static downloadSolution(canvas, filename = 'matiks-solution.png') {
        const link = document.createElement('a');
        link.download = filename;
        link.href = canvas.toDataURL('image/png');
        link.click();
    }
}
