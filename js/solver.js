/**
 * ============================================================================
 * solver.js — 6×6 Sudoku Solver
 * ============================================================================
 * 
 * Algorithm: Backtracking with Forward Checking & MRV (Minimum Remaining Values)
 * 
 * Forward Checking: After each assignment, immediately removes the assigned
 * value from the domains of all peer cells (same row, column, box). If any
 * peer's domain becomes empty, we backtrack immediately — pruning large
 * portions of the search tree before exploring them.
 * 
 * MRV Heuristic: Always selects the unassigned cell with the fewest remaining
 * candidate values. This "fail-first" strategy detects dead ends as early as
 * possible, dramatically reducing the number of nodes explored.
 * 
 * For a 6×6 grid (36 cells, values 1-6, 2×3 boxes), the search space is tiny.
 * Typical solve time: <1ms on modern hardware (well under the 50ms target).
 * 
 * ============================================================================
 */

class SudokuSolver {
    /**
     * @param {number[][]} grid - 6×6 array where 0 = empty cell, 1-6 = given digit
     */
    constructor(grid) {
        this.SIZE = 6;
        this.BOX_ROWS = 2;   // Each box spans 2 rows
        this.BOX_COLS = 3;   // Each box spans 3 columns
        this.VALUES = [1, 2, 3, 4, 5, 6];

        // Deep copy the input grid
        this.grid = grid.map(row => [...row]);
        
        // Track which cells were originally given (for overlay rendering)
        this.givenCells = grid.map(row => row.map(val => val !== 0));
        
        // Constraint domains: Map of "row,col" -> Set of possible values
        this.domains = new Map();
        
        // Performance tracking
        this.nodesExplored = 0;
        this.solveTimeMs = 0;
    }

    // ========================================================================
    // Validation — Checks if the initial puzzle state is valid
    // ========================================================================

    /**
     * Validates the initial puzzle configuration.
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validate() {
        const errors = [];

        // Check all values are in valid range
        for (let r = 0; r < this.SIZE; r++) {
            for (let c = 0; c < this.SIZE; c++) {
                const val = this.grid[r][c];
                if (val !== 0 && (val < 1 || val > 6 || !Number.isInteger(val))) {
                    errors.push(`Invalid value ${val} at row ${r + 1}, col ${c + 1}. Must be 1-6.`);
                }
            }
        }

        // Check no duplicate digits in any row
        for (let r = 0; r < this.SIZE; r++) {
            const seen = new Set();
            for (let c = 0; c < this.SIZE; c++) {
                const val = this.grid[r][c];
                if (val !== 0) {
                    if (seen.has(val)) {
                        errors.push(`Duplicate value ${val} in row ${r + 1}.`);
                    }
                    seen.add(val);
                }
            }
        }

        // Check no duplicate digits in any column
        for (let c = 0; c < this.SIZE; c++) {
            const seen = new Set();
            for (let r = 0; r < this.SIZE; r++) {
                const val = this.grid[r][c];
                if (val !== 0) {
                    if (seen.has(val)) {
                        errors.push(`Duplicate value ${val} in column ${c + 1}.`);
                    }
                    seen.add(val);
                }
            }
        }

        // Check no duplicate digits in any 2×3 box
        for (let boxR = 0; boxR < this.SIZE; boxR += this.BOX_ROWS) {
            for (let boxC = 0; boxC < this.SIZE; boxC += this.BOX_COLS) {
                const seen = new Set();
                for (let r = boxR; r < boxR + this.BOX_ROWS; r++) {
                    for (let c = boxC; c < boxC + this.BOX_COLS; c++) {
                        const val = this.grid[r][c];
                        if (val !== 0) {
                            if (seen.has(val)) {
                                const boxNum = (boxR / this.BOX_ROWS) * (this.SIZE / this.BOX_COLS) + (boxC / this.BOX_COLS) + 1;
                                errors.push(`Duplicate value ${val} in box ${boxNum}.`);
                            }
                            seen.add(val);
                        }
                    }
                }
            }
        }

        return { valid: errors.length === 0, errors };
    }

    // ========================================================================
    // Domain Initialization — Computes initial possible values for each cell
    // ========================================================================

    /**
     * Initializes constraint domains for all empty cells.
     * Each domain starts as {1,2,3,4,5,6} minus values already present
     * in the cell's row, column, and box.
     * @returns {boolean} false if any domain is immediately empty (unsolvable)
     */
    initDomains() {
        this.domains.clear();

        for (let r = 0; r < this.SIZE; r++) {
            for (let c = 0; c < this.SIZE; c++) {
                if (this.grid[r][c] === 0) {
                    const domain = new Set(this.VALUES);

                    // Remove values in the same row
                    for (let cc = 0; cc < this.SIZE; cc++) {
                        domain.delete(this.grid[r][cc]);
                    }

                    // Remove values in the same column
                    for (let rr = 0; rr < this.SIZE; rr++) {
                        domain.delete(this.grid[rr][c]);
                    }

                    // Remove values in the same box
                    const boxR = Math.floor(r / this.BOX_ROWS) * this.BOX_ROWS;
                    const boxC = Math.floor(c / this.BOX_COLS) * this.BOX_COLS;
                    for (let rr = boxR; rr < boxR + this.BOX_ROWS; rr++) {
                        for (let cc = boxC; cc < boxC + this.BOX_COLS; cc++) {
                            domain.delete(this.grid[rr][cc]);
                        }
                    }

                    // If any cell has zero candidates, puzzle is unsolvable
                    if (domain.size === 0) return false;

                    this.domains.set(`${r},${c}`, domain);
                }
            }
        }

        return true;
    }

    // ========================================================================
    // MRV Heuristic — Selects the most constrained cell
    // ========================================================================

    /**
     * Selects the empty cell with the fewest remaining candidates (MRV).
     * This "fail-first" strategy dramatically prunes the search tree.
     * @returns {number[]|null} [row, col] of the best cell, or null if all filled
     */
    selectMRV() {
        let minSize = Infinity;
        let bestCell = null;

        for (const [key, domain] of this.domains) {
            if (domain.size < minSize) {
                minSize = domain.size;
                bestCell = key;
                // If we find a cell with only 1 candidate, it's the best possible choice
                if (minSize === 1) break;
            }
        }

        if (bestCell === null) return null;
        return bestCell.split(',').map(Number);
    }

    // ========================================================================
    // Forward Checking — Propagates constraints after an assignment
    // ========================================================================

    /**
     * After assigning `val` to (row, col), removes `val` from the domains
     * of all peer cells (same row, col, and box).
     * 
     * @param {number} row - Row of the assigned cell
     * @param {number} col - Column of the assigned cell
     * @param {number} val - The assigned value
     * @returns {Array|null} Array of {key, val} removed entries for backtracking,
     *                       or null if a domain becomes empty (contradiction)
     */
    forwardCheck(row, col, val) {
        const removed = [];

        // Collect all peer cell keys that need checking
        const peers = new Set();

        // Same row peers
        for (let c = 0; c < this.SIZE; c++) {
            if (c !== col) peers.add(`${row},${c}`);
        }

        // Same column peers
        for (let r = 0; r < this.SIZE; r++) {
            if (r !== row) peers.add(`${r},${col}`);
        }

        // Same box peers
        const boxR = Math.floor(row / this.BOX_ROWS) * this.BOX_ROWS;
        const boxC = Math.floor(col / this.BOX_COLS) * this.BOX_COLS;
        for (let r = boxR; r < boxR + this.BOX_ROWS; r++) {
            for (let c = boxC; c < boxC + this.BOX_COLS; c++) {
                if (r !== row || c !== col) peers.add(`${r},${c}`);
            }
        }

        // Remove val from each peer's domain
        for (const key of peers) {
            const domain = this.domains.get(key);
            if (domain && domain.has(val)) {
                domain.delete(val);
                removed.push({ key, val });

                // Contradiction: a peer has no valid candidates left
                if (domain.size === 0) {
                    // Restore what we've removed so far before returning
                    this.restoreDomains(removed);
                    return null;
                }
            }
        }

        return removed;
    }

    /**
     * Restores domain values that were removed during forward checking.
     * Called during backtracking to undo constraint propagation.
     * @param {Array} removed - Array of {key, val} entries to restore
     */
    restoreDomains(removed) {
        if (!removed) return;
        for (const entry of removed) {
            const domain = this.domains.get(entry.key);
            if (domain) {
                domain.add(entry.val);
            }
        }
    }

    // ========================================================================
    // Main Solve — Recursive backtracking with forward checking + MRV
    // ========================================================================

    /**
     * Public entry point. Validates, initializes, and solves the puzzle.
     * @returns {{ solved: boolean, grid: number[][], givenCells: boolean[][], 
     *             timeMs: number, nodesExplored: number, errors: string[] }}
     */
    solve() {
        // Step 1: Validate the initial puzzle
        const validation = this.validate();
        if (!validation.valid) {
            return {
                solved: false,
                grid: this.grid,
                givenCells: this.givenCells,
                timeMs: 0,
                nodesExplored: 0,
                errors: validation.errors
            };
        }

        // Step 2: Initialize domains (compute initial candidates per cell)
        const t0 = performance.now();
        this.nodesExplored = 0;

        const domainsValid = this.initDomains();
        if (!domainsValid) {
            return {
                solved: false,
                grid: this.grid,
                givenCells: this.givenCells,
                timeMs: performance.now() - t0,
                nodesExplored: 0,
                errors: ['Puzzle is unsolvable: a cell has no valid candidates.']
            };
        }

        // Step 3: Solve using recursive backtracking
        const success = this._solve();
        const elapsed = performance.now() - t0;
        this.solveTimeMs = elapsed;

        return {
            solved: success,
            grid: this.grid,
            givenCells: this.givenCells,
            timeMs: elapsed,
            nodesExplored: this.nodesExplored,
            errors: success ? [] : ['Puzzle is unsolvable: no valid solution exists.']
        };
    }

    /**
     * Recursive backtracking core.
     * @returns {boolean} true if a solution was found
     */
    _solve() {
        this.nodesExplored++;

        // Select the most constrained cell (MRV heuristic)
        const cell = this.selectMRV();

        // If no empty cell remains, puzzle is solved!
        if (cell === null) return true;

        const [row, col] = cell;
        const key = `${row},${col}`;
        const candidates = [...this.domains.get(key)];

        // Remove this cell from domains map (it's being assigned)
        const savedDomain = this.domains.get(key);
        this.domains.delete(key);

        // Try each candidate value
        for (const val of candidates) {
            // Assign the value
            this.grid[row][col] = val;

            // Forward check: propagate constraints to peers
            const removed = this.forwardCheck(row, col, val);

            if (removed !== null) {
                // No contradiction — recurse deeper
                if (this._solve()) return true;

                // Backtrack: undo the constraint propagation
                this.restoreDomains(removed);
            }

            // Backtrack: undo the assignment
            this.grid[row][col] = 0;
        }

        // Restore this cell's domain for parent call
        this.domains.set(key, savedDomain);

        return false;
    }

    // ========================================================================
    // Utility — Get the solution grid
    // ========================================================================

    /**
     * Returns a clean copy of the current grid state.
     * @returns {number[][]}
     */
    getGrid() {
        return this.grid.map(row => [...row]);
    }

    /**
     * Checks if a specific value placement is valid (for manual input validation).
     * @param {number} row 
     * @param {number} col 
     * @param {number} val 
     * @returns {boolean}
     */
    isValidPlacement(row, col, val) {
        // Check row
        for (let c = 0; c < this.SIZE; c++) {
            if (c !== col && this.grid[row][c] === val) return false;
        }
        // Check column
        for (let r = 0; r < this.SIZE; r++) {
            if (r !== row && this.grid[r][col] === val) return false;
        }
        // Check box
        const boxR = Math.floor(row / this.BOX_ROWS) * this.BOX_ROWS;
        const boxC = Math.floor(col / this.BOX_COLS) * this.BOX_COLS;
        for (let r = boxR; r < boxR + this.BOX_ROWS; r++) {
            for (let c = boxC; c < boxC + this.BOX_COLS; c++) {
                if ((r !== row || c !== col) && this.grid[r][c] === val) return false;
            }
        }
        return true;
    }
}

// Static convenience method for quick solving
SudokuSolver.quickSolve = function(grid) {
    const solver = new SudokuSolver(grid);
    return solver.solve();
};
