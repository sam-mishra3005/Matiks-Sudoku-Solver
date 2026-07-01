/**
 * ============================================================================
 * ocrEngine.js — Tesseract.js OCR Engine with Caching & Parallel Workers
 * ============================================================================
 * 
 * Uses Tesseract.js v5+ for digit recognition on individual cells.
 * 
 * Key optimizations:
 * - PSM_SINGLE_CHAR (mode 10): treats each cell as a single character
 * - Whitelist '123456': restricts recognition to valid Sudoku digits
 * - Scheduler with multiple workers: parallel OCR for all 36 cells
 * - Image fingerprint caching: skips OCR for re-uploaded images
 * - Content pre-check: skips empty cells without invoking Tesseract
 * 
 * Tesseract.js manages its own internal Web Workers for the heavy
 * computation, so the main thread remains responsive during OCR.
 * 
 * ============================================================================
 */

class OCREngine {
    constructor() {
        /** @type {Tesseract.Scheduler|null} */
        this.scheduler = null;
        this.initialized = false;
        this.initializing = false;

        /** Number of parallel Tesseract workers */
        this.workerCount = 4;

        /** Cache: imageHash → { grid: number[][], confidence: number[][] } */
        this.cache = new Map();

        /** Progress callback */
        this.onProgress = null;
    }

    // ========================================================================
    // Initialization — Creates Tesseract scheduler with parallel workers
    // ========================================================================

    /**
     * Initializes the Tesseract.js scheduler with multiple workers.
     * Each worker is configured for single-character digit recognition.
     * 
     * This should be called early (e.g., on page load) to amortize the
     * ~2-3 second initialization time before the user uploads an image.
     * 
     * @param {Function} [progressCb] - Optional progress callback
     */
    async init(progressCb) {
        if (this.initialized || this.initializing) return;
        this.initializing = true;
        this.onProgress = progressCb || null;

        try {
            this.scheduler = Tesseract.createScheduler();

            // Create multiple workers for parallel cell recognition
            for (let i = 0; i < this.workerCount; i++) {
                const worker = await Tesseract.createWorker('eng', 1, {
                    // Reduce logging in production
                    logger: () => {}
                });

                // Configure for single digit recognition
                await worker.setParameters({
                    tessedit_char_whitelist: '123456',
                    tessedit_pageseg_mode: '10',  // PSM_SINGLE_CHAR
                });

                this.scheduler.addWorker(worker);

                if (this.onProgress) {
                    this.onProgress({
                        stage: 'init',
                        progress: (i + 1) / this.workerCount,
                        message: `Initializing OCR worker ${i + 1}/${this.workerCount}`
                    });
                }
            }

            this.initialized = true;
            this.initializing = false;
        } catch (error) {
            this.initializing = false;
            throw new Error(`OCR initialization failed: ${error.message}`);
        }
    }

    /**
     * Recognizes digits in all cell images.
     * 
     * Pipeline:
     *   1. Content detection on RAW cell images (variance-based)
     *   2. Process cells with content for OCR (Otsu threshold path)
     *   3. If primary OCR fails, fallback to enhanced grayscale path
     *   4. Return 6×6 grid with confidence levels
     * 
     * @param {Array<{row, col, canvas}>} cellImages - Cell images from GridDetector.extractCellImages()
     * @param {string} [imageHash] - Optional hash for caching
     * @returns {Promise<{ grid: number[][], confidence: number[][], uncertainCells: Array }>}
     */
    async recognizeGrid(cellImages, imageHash = null) {
        // Check cache first
        if (imageHash && this.cache.has(imageHash)) {
            console.log('🔁 OCR: Cache hit, skipping recognition');
            return this.cache.get(imageHash);
        }

        if (!this.initialized) {
            await this.init();
        }

        const grid = Array.from({ length: 6 }, () => Array(6).fill(0));
        const confidence = Array.from({ length: 6 }, () => Array(6).fill(0));
        const uncertainCells = [];

        // ── Step 1: Content detection on RAW cells (before any processing) ──
        const cellsWithContent = [];
        const emptyCells = [];

        console.log('📊 OCR: Checking cell content (stddev-based)...');

        for (const cellImage of cellImages) {
            // Check on the RAW cell — NOT on a processed version
            const contentCheck = GridDetector.cellHasContent(cellImage.canvas);

            if (contentCheck.hasContent) {
                cellsWithContent.push({
                    ...cellImage,
                    stddev: contentCheck.stddev
                });
                console.log(`  ✅ Cell (${cellImage.row},${cellImage.col}): has content (σ=${contentCheck.stddev.toFixed(1)})`);
            } else {
                emptyCells.push(cellImage);
                grid[cellImage.row][cellImage.col] = 0;
                confidence[cellImage.row][cellImage.col] = 100;
                console.log(`  ⬜ Cell (${cellImage.row},${cellImage.col}): empty (σ=${contentCheck.stddev.toFixed(1)})`);
            }
        }

        console.log(`📊 OCR: ${cellsWithContent.length} cells with content, ${emptyCells.length} empty`);

        if (this.onProgress) {
            this.onProgress({
                stage: 'ocr',
                progress: 0,
                message: `Recognizing ${cellsWithContent.length} cells (${emptyCells.length} empty)...`
            });
        }

        // ── Step 2: Process and OCR cells with content ──
        let completed = 0;
        const total = cellsWithContent.length;

        const ocrPromises = cellsWithContent.map(async (cell) => {
            try {
                // Process the raw cell for OCR (Otsu threshold + smart inversion)
                const processed = ImageProcessor.processForOCR(cell.canvas);

                // Primary attempt: use the binarized (processed) cell
                let result = await this.scheduler.addJob('recognize', processed.canvas);
                let text = result.data.text.trim();
                let conf = result.data.confidence;
                let digit = parseInt(text);

                console.log(`  🔍 Cell (${cell.row},${cell.col}) primary: text="${text}" conf=${conf.toFixed(1)} digit=${digit}`);

                // If primary path failed, try fallback: enhanced grayscale (let Tesseract binarize)
                if (!(digit >= 1 && digit <= 6 && conf > 30)) {
                    const enhanced = ImageProcessor.enhanceForOCR(cell.canvas);
                    result = await this.scheduler.addJob('recognize', enhanced);
                    text = result.data.text.trim();
                    conf = result.data.confidence;
                    digit = parseInt(text);
                    console.log(`  🔄 Cell (${cell.row},${cell.col}) fallback: text="${text}" conf=${conf.toFixed(1)} digit=${digit}`);
                }

                if (digit >= 1 && digit <= 6 && conf > 25) {
                    grid[cell.row][cell.col] = digit;
                    confidence[cell.row][cell.col] = conf;

                    // Flag low-confidence results for manual review
                    if (conf < 60) {
                        uncertainCells.push({
                            row: cell.row,
                            col: cell.col,
                            digit,
                            confidence: conf,
                            reason: 'low_confidence'
                        });
                    }
                } else if (cell.stddev > 20) {
                    // High stddev but couldn't recognize — flag for manual input
                    grid[cell.row][cell.col] = 0;
                    confidence[cell.row][cell.col] = 0;
                    uncertainCells.push({
                        row: cell.row,
                        col: cell.col,
                        digit: digit || 0,
                        confidence: conf,
                        reason: 'unrecognized'
                    });
                    console.warn(`  ⚠️ Cell (${cell.row},${cell.col}): content detected but not recognized`);
                } else {
                    // Low confidence and low stddev — probably empty after all
                    grid[cell.row][cell.col] = 0;
                    confidence[cell.row][cell.col] = 100;
                }
            } catch (error) {
                console.error(`  ❌ OCR error for cell (${cell.row},${cell.col}):`, error);
                grid[cell.row][cell.col] = 0;
                confidence[cell.row][cell.col] = 0;
                uncertainCells.push({
                    row: cell.row,
                    col: cell.col,
                    digit: 0,
                    confidence: 0,
                    reason: 'error'
                });
            }

            completed++;
            if (this.onProgress) {
                this.onProgress({
                    stage: 'ocr',
                    progress: completed / total,
                    message: `Recognized ${completed}/${total} cells`
                });
            }
        });

        await Promise.all(ocrPromises);

        const result = { grid, confidence, uncertainCells };

        // Cache the result
        if (imageHash) {
            this.cache.set(imageHash, result);
        }

        return result;
    }

    // ========================================================================
    // Caching Utilities
    // ========================================================================

    /**
     * Generates a fast hash/fingerprint of a canvas image for caching.
     * Samples a grid of pixels and creates a unique-enough string.
     * 
     * @param {HTMLCanvasElement} canvas - The source image canvas
     * @returns {string} A fingerprint string
     */
    static generateImageHash(canvas) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        // Sample 16×16 grid of pixels
        const sampleSize = 16;
        const stepX = Math.floor(w / sampleSize);
        const stepY = Math.floor(h / sampleSize);

        let hash = `${w}x${h}:`;
        for (let y = 0; y < sampleSize; y++) {
            for (let x = 0; x < sampleSize; x++) {
                const pixel = ctx.getImageData(x * stepX, y * stepY, 1, 1).data;
                // Use just the red and green channels for speed
                hash += ((pixel[0] >> 4) << 4 | (pixel[1] >> 4)).toString(16);
            }
        }

        return hash;
    }

    /**
     * Clears the OCR result cache.
     */
    clearCache() {
        this.cache.clear();
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    /**
     * Terminates all Tesseract workers and cleans up resources.
     */
    async terminate() {
        if (this.scheduler) {
            await this.scheduler.terminate();
            this.scheduler = null;
        }
        this.initialized = false;
        this.initializing = false;
    }
}
