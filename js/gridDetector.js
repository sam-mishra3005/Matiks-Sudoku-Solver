/**
 * ============================================================================
 * gridDetector.js — Grid Detection & Cell Extraction
 * ============================================================================
 * 
 * Detects the 6×6 Sudoku grid in the image and extracts individual cells.
 * 
 * Strategy (two-phase for robustness):
 * 
 * Phase 1 — Color-based detection (fast path):
 *   Looks for colored grid lines (e.g., green lines on dark background).
 *   Uses projection histograms on the color-filtered mask to find line positions.
 *   Very fast and reliable for digital/screenshot puzzles.
 * 
 * Phase 2 — Edge-based detection (fallback):
 *   Uses Sobel gradient magnitudes + projection histograms.
 *   Works for printed puzzles, photos, and any grid style.
 * 
 * Both methods produce 7 horizontal and 7 vertical line positions that
 * define the 36 cells of the 6×6 grid.
 * 
 * ============================================================================
 */

class GridDetector {

    /**
     * Main entry point: detects the grid and extracts cell regions.
     * 
     * @param {HTMLCanvasElement} canvas - Canvas with the puzzle image
     * @param {Object} processedData - Output from ImageProcessor.processForGridDetection()
     * @returns {{ cells: Array<{row,col,x,y,w,h}>, gridBounds: {x,y,w,h}, success: boolean, method: string }}
     */
    static detect(canvas, processedData) {
        const { colorData, gray, binary, width, height } = processedData;

        // Try color-based detection first (for digital/screenshot puzzles)
        let result = GridDetector.colorBasedDetection(colorData, width, height);
        
        if (result.success) {
            result.method = 'color';
            result.cells = GridDetector.computeCells(result.hLines, result.vLines);
            return result;
        }

        // Fallback: edge-based detection
        result = GridDetector.edgeBasedDetection(gray, width, height);
        
        if (result.success) {
            result.method = 'edge';
            result.cells = GridDetector.computeCells(result.hLines, result.vLines);
            return result;
        }

        // Last resort: assume the entire image is the grid
        result = GridDetector.uniformGridFallback(width, height);
        result.method = 'fallback';
        return result;
    }

    // ========================================================================
    // Phase 1: Color-Based Detection
    // ========================================================================

    /**
     * Detects grid lines by color filtering. Looks for pixels where one
     * color channel significantly dominates (e.g., green grid lines).
     * 
     * Projects the color mask onto X and Y axes, then finds peaks
     * that correspond to grid line positions.
     * 
     * @param {Uint8Array} colorData - RGBA pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {{ success: boolean, hLines: number[], vLines: number[], gridBounds: Object }}
     */
    static colorBasedDetection(colorData, width, height) {
        // Create mask of "grid line" pixels
        // Strategy: find pixels that are bright and have a dominant color channel
        // (handles green, blue, red, or white grid lines)
        const mask = new Uint8Array(width * height);

        // First pass: detect which color channel dominates (if any)
        const channelSums = [0, 0, 0]; // R, G, B
        let brightPixels = 0;

        for (let i = 0; i < colorData.length; i += 4) {
            const r = colorData[i], g = colorData[i + 1], b = colorData[i + 2];
            const maxC = Math.max(r, g, b);
            const brightness = (r + g + b) / 3;

            // Only consider "bright" pixels that could be grid lines
            if (brightness > 80 && maxC > 100) {
                brightPixels++;
                channelSums[0] += r;
                channelSums[1] += g;
                channelSums[2] += b;
            }
        }

        if (brightPixels < width * height * 0.01) {
            return { success: false };
        }

        // Determine dominant channel
        const avgChannels = channelSums.map(s => s / brightPixels);
        const dominantIdx = avgChannels.indexOf(Math.max(...avgChannels));

        // Build mask: pixels where the dominant channel is strong
        // and significantly higher than the background
        for (let i = 0; i < colorData.length; i += 4) {
            const r = colorData[i], g = colorData[i + 1], b = colorData[i + 2];
            const channels = [r, g, b];
            const dominant = channels[dominantIdx];
            const others = channels.filter((_, idx) => idx !== dominantIdx);
            const othersAvg = (others[0] + others[1]) / 2;
            
            // Grid line: dominant channel is bright and stands out
            const isGridLine = dominant > 80 && (dominant - othersAvg > 20 || (r + g + b) / 3 > 150);
            
            mask[i / 4] = isGridLine ? 1 : 0;
        }

        // Project onto axes
        const hProjection = new Float32Array(height); // horizontal = rows
        const vProjection = new Float32Array(width);  // vertical = columns

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (mask[y * width + x]) {
                    hProjection[y]++;
                    vProjection[x]++;
                }
            }
        }

        // Find peaks in projections (grid lines)
        const hLines = GridDetector.findGridLines(hProjection, height, 7);
        const vLines = GridDetector.findGridLines(vProjection, width, 7);

        if (hLines.length >= 2 && vLines.length >= 2) {
            // Ensure we have exactly 7 lines (or interpolate)
            const finalH = GridDetector.ensureLines(hLines, 7, height);
            const finalV = GridDetector.ensureLines(vLines, 7, width);

            return {
                success: true,
                hLines: finalH,
                vLines: finalV,
                gridBounds: {
                    x: finalV[0],
                    y: finalH[0],
                    w: finalV[finalV.length - 1] - finalV[0],
                    h: finalH[finalH.length - 1] - finalH[0]
                }
            };
        }

        return { success: false };
    }

    // ========================================================================
    // Phase 2: Edge-Based Detection (Fallback)
    // ========================================================================

    /**
     * Detects grid lines using Sobel edge detection + projection.
     * Works for any grid style (printed, photographed, etc.)
     * 
     * @param {Float32Array} gray - Grayscale image values
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {{ success: boolean, hLines: number[], vLines: number[], gridBounds: Object }}
     */
    static edgeBasedDetection(gray, width, height) {
        // Compute horizontal edges (for finding horizontal lines)
        const hEdges = new Float32Array(width * height);
        // Compute vertical edges (for finding vertical lines)
        const vEdges = new Float32Array(width * height);

        // Sobel kernels
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;

                // Horizontal Sobel (detects horizontal edges)
                const gy =
                    -gray[(y - 1) * width + (x - 1)] - 2 * gray[(y - 1) * width + x] - gray[(y - 1) * width + (x + 1)] +
                     gray[(y + 1) * width + (x - 1)] + 2 * gray[(y + 1) * width + x] + gray[(y + 1) * width + (x + 1)];

                // Vertical Sobel (detects vertical edges)
                const gx =
                    -gray[(y - 1) * width + (x - 1)] - 2 * gray[y * width + (x - 1)] - gray[(y + 1) * width + (x - 1)] +
                     gray[(y - 1) * width + (x + 1)] + 2 * gray[y * width + (x + 1)] + gray[(y + 1) * width + (x + 1)];

                hEdges[idx] = Math.abs(gy);
                vEdges[idx] = Math.abs(gx);
            }
        }

        // Project horizontal edges onto Y axis (find horizontal line positions)
        const hProjection = new Float32Array(height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                hProjection[y] += hEdges[y * width + x];
            }
        }

        // Project vertical edges onto X axis (find vertical line positions)
        const vProjection = new Float32Array(width);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                vProjection[x] += vEdges[y * width + x];
            }
        }

        // Find peaks
        const hLines = GridDetector.findGridLines(hProjection, height, 7);
        const vLines = GridDetector.findGridLines(vProjection, width, 7);

        if (hLines.length >= 2 && vLines.length >= 2) {
            const finalH = GridDetector.ensureLines(hLines, 7, height);
            const finalV = GridDetector.ensureLines(vLines, 7, width);

            return {
                success: true,
                hLines: finalH,
                vLines: finalV,
                gridBounds: {
                    x: finalV[0],
                    y: finalH[0],
                    w: finalV[finalV.length - 1] - finalV[0],
                    h: finalH[finalH.length - 1] - finalH[0]
                }
            };
        }

        return { success: false };
    }

    // ========================================================================
    // Fallback: Assume Entire Image is the Grid
    // ========================================================================

    /**
     * If all detection methods fail, assume the image is the grid.
     * Divides uniformly into 6×6 cells with small padding.
     */
    static uniformGridFallback(width, height) {
        const padding = Math.round(Math.min(width, height) * 0.02);
        const gridW = width - 2 * padding;
        const gridH = height - 2 * padding;

        const hLines = [];
        const vLines = [];
        for (let i = 0; i <= 6; i++) {
            hLines.push(padding + Math.round(gridH * i / 6));
            vLines.push(padding + Math.round(gridW * i / 6));
        }

        return {
            success: true,
            hLines,
            vLines,
            gridBounds: { x: padding, y: padding, w: gridW, h: gridH },
            cells: GridDetector.computeCells(hLines, vLines)
        };
    }

    // ========================================================================
    // Peak Finding — Identifies grid line positions from projection histograms
    // ========================================================================

    /**
     * Finds peaks in a 1D projection histogram that correspond to grid lines.
     * Uses local maximum detection with minimum distance between peaks.
     * 
     * @param {Float32Array} projection - 1D projection histogram
     * @param {number} length - Length of the projection
     * @param {number} expectedCount - Expected number of lines (typically 7 for 6×6 grid)
     * @returns {number[]} Sorted array of peak positions
     */
    static findGridLines(projection, length, expectedCount) {
        // Compute the threshold as a fraction of the max value
        let maxVal = 0;
        for (let i = 0; i < length; i++) {
            if (projection[i] > maxVal) maxVal = projection[i];
        }

        const threshold = maxVal * 0.3;
        const minDist = Math.floor(length / (expectedCount * 2));

        // Find all local maxima above threshold
        const peaks = [];
        for (let i = 1; i < length - 1; i++) {
            if (projection[i] >= threshold &&
                projection[i] >= projection[i - 1] &&
                projection[i] >= projection[i + 1]) {
                peaks.push({ pos: i, val: projection[i] });
            }
        }

        // Sort by value (strongest peaks first)
        peaks.sort((a, b) => b.val - a.val);

        // Non-maximum suppression: keep peaks that are far enough apart
        const selected = [];
        for (const peak of peaks) {
            let tooClose = false;
            for (const existing of selected) {
                if (Math.abs(peak.pos - existing.pos) < minDist) {
                    tooClose = true;
                    break;
                }
            }
            if (!tooClose) {
                selected.push(peak);
            }
        }

        // Sort by position
        selected.sort((a, b) => a.pos - b.pos);
        return selected.map(p => p.pos);
    }

    /**
     * Ensures we have exactly `count` evenly-spaced lines.
     * If we found too few peaks, interpolates missing ones.
     * If we found too many, selects the best-fitting set.
     * 
     * @param {number[]} lines - Detected line positions (sorted)
     * @param {number} count - Required number of lines
     * @param {number} totalLength - Total image dimension
     * @returns {number[]} Exactly `count` line positions
     */
    static ensureLines(lines, count, totalLength) {
        if (lines.length === count) return lines;

        if (lines.length >= 2) {
            // We have at least the outer boundaries — interpolate uniformly
            const start = lines[0];
            const end = lines[lines.length - 1];
            const step = (end - start) / (count - 1);
            const result = [];
            for (let i = 0; i < count; i++) {
                result.push(Math.round(start + step * i));
            }
            return result;
        }

        // No lines detected — use full dimension
        const step = totalLength / count;
        const result = [];
        for (let i = 0; i < count; i++) {
            result.push(Math.round(step * i));
        }
        return result;
    }

    // ========================================================================
    // Cell Computation & Extraction
    // ========================================================================

    /**
     * Computes cell rectangles from horizontal and vertical line positions.
     * 
     * @param {number[]} hLines - 7 horizontal line Y-positions
     * @param {number[]} vLines - 7 vertical line X-positions
     * @returns {Array<{row: number, col: number, x: number, y: number, w: number, h: number}>}
     */
    static computeCells(hLines, vLines) {
        const cells = [];
        for (let row = 0; row < 6; row++) {
            for (let col = 0; col < 6; col++) {
                const x = vLines[col];
                const y = hLines[row];
                const w = vLines[col + 1] - vLines[col];
                const h = hLines[row + 1] - hLines[row];
                cells.push({ row, col, x, y, w, h });
            }
        }
        return cells;
    }

    /**
     * Extracts individual cell images from the main canvas.
     * 
     * IMPORTANT: Returns RAW cell crops WITHOUT white padding or background fill.
     * The processForOCR pipeline handles padding and binarization separately.
     * This prevents the white padding from contaminating contrast stretch and
     * threshold calculations.
     * 
     * @param {HTMLCanvasElement} sourceCanvas - The full puzzle image canvas
     * @param {Array} cells - Cell rectangles from computeCells()
     * @param {number} outputSize - Output cell image size (square, default 100px)
     * @returns {Array<{row: number, col: number, canvas: HTMLCanvasElement}>}
     */
    static extractCellImages(sourceCanvas, cells, outputSize = 100) {
        const cellImages = [];

        for (const cell of cells) {
            // Apply 18% inner margin to avoid grid line artifacts
            const marginX = Math.round(cell.w * 0.18);
            const marginY = Math.round(cell.h * 0.18);
            
            const cropX = cell.x + marginX;
            const cropY = cell.y + marginY;
            const cropW = cell.w - 2 * marginX;
            const cropH = cell.h - 2 * marginY;

            // Skip cells that are too small
            if (cropW < 4 || cropH < 4) continue;

            // Create output canvas — RAW crop, no padding, no background fill
            const cellCanvas = document.createElement('canvas');
            cellCanvas.width = outputSize;
            cellCanvas.height = outputSize;
            const cellCtx = cellCanvas.getContext('2d');

            // Draw the cell content scaled to fill the output canvas
            cellCtx.drawImage(
                sourceCanvas,
                cropX, cropY, cropW, cropH,
                0, 0, outputSize, outputSize
            );

            cellImages.push({
                row: cell.row,
                col: cell.col,
                canvas: cellCanvas,
                // Store original coordinates for overlay rendering
                originalX: cell.x,
                originalY: cell.y,
                originalW: cell.w,
                originalH: cell.h
            });
        }

        return cellImages;
    }

    /**
     * Checks if a cell image appears to contain a digit.
     * 
     * Uses STANDARD DEVIATION of pixel intensities — far more robust than
     * fill ratio. An empty cell is nearly uniform (low stddev). A cell with
     * a digit has significant intensity variation (high stddev).
     * 
     * @param {HTMLCanvasElement} cellCanvas - The RAW cell image canvas
     * @returns {{ hasContent: boolean, stddev: number }}
     */
    static cellHasContent(cellCanvas) {
        const ctx = cellCanvas.getContext('2d');
        const w = cellCanvas.width;
        const h = cellCanvas.height;
        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;

        const totalPixels = w * h;

        // Compute mean brightness
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
            sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        const mean = sum / totalPixels;

        // Compute variance
        let varianceSum = 0;
        for (let i = 0; i < data.length; i += 4) {
            const brightness = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            const diff = brightness - mean;
            varianceSum += diff * diff;
        }
        const stddev = Math.sqrt(varianceSum / totalPixels);

        // A uniform dark cell (empty): stddev ≈ 3-10
        // A cell with a gray digit on dark bg: stddev ≈ 20-60
        // Threshold of 12 is conservative to avoid false negatives
        return {
            hasContent: stddev > 12,
            stddev
        };
    }
}
