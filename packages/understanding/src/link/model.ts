// The linker's model (spec Decision 4): an L2-regularized logistic regression over the candidate
// features, fit by Newton's method. Fit on the calibration split's candidate rows, where the
// positive is the gold record, its output is a calibrated probability in one step (Platt-style).
// Deterministic: it starts from zero, visits rows in order, and solves each Newton step with a
// Cholesky factorization, so the same rows give the same weights on any machine.
//
// The objective is the negative log-likelihood plus (λ/2)·‖w‖², the bias left unpenalized:
// scikit-learn's `LogisticRegression` default with C = 1/λ. λ = 1 is the spec's target. The
// penalty applies to standardized features (each column centred and scaled to unit variance), as
// is usual, so it weighs every feature alike whatever its range: on the raw columns, a rare
// binary feature such as `exact` would pay many times more for the same effect, and the fit would
// come out underconfident. The weights are mapped back to the raw features, so callers never see
// the scaling.

/** The logistic function, without overflow for large |z|. */
export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** log(1 + e^x), without overflow. */
function softplus(x: number): number {
  return x > 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x));
}

export interface LogisticFit {
  readonly bias: number;
  /** One per column of the rows, in order. */
  readonly weights: readonly number[];
  /** Newton steps taken. */
  readonly iterations: number;
  readonly converged: boolean;
  /** The penalized negative log-likelihood at the fit. */
  readonly objective: number;
}

export interface FitOptions {
  /** The L2 penalty on the weights (not the bias). Default 1. */
  readonly lambda?: number;
  /** Default 100. */
  readonly maxIterations?: number;
  /** Stop when no parameter moves more than this. Default 1e-10. */
  readonly tolerance?: number;
  /** Penalize standardized features rather than raw ones (see above). Default true. */
  readonly standardize?: boolean;
}

/** Solves A·x = b for a symmetric positive-definite A (row-major, n × n), by Cholesky. */
function solve(a: Float64Array, b: Float64Array, n: number): Float64Array {
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i * n + j] ?? 0;
      for (let k = 0; k < j; k++) sum -= (l[i * n + k] ?? 0) * (l[j * n + k] ?? 0);
      if (i === j) {
        // A tiny floor keeps a numerically singular pivot (every p saturated) solvable.
        l[i * n + i] = Math.sqrt(Math.max(sum, 1e-12));
      } else {
        l[i * n + j] = sum / (l[j * n + j] ?? 1);
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i] ?? 0;
    for (let k = 0; k < i; k++) sum -= (l[i * n + k] ?? 0) * (y[k] ?? 0);
    y[i] = sum / (l[i * n + i] ?? 1);
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i] ?? 0;
    for (let k = i + 1; k < n; k++) sum -= (l[k * n + i] ?? 0) * (x[k] ?? 0);
    x[i] = sum / (l[i * n + i] ?? 1);
  }
  return x;
}

/**
 * Fits the model. `rows[i]` holds row i's features and `labels[i]` is 1 for a positive, 0 for a
 * negative. Each Newton step is halved until the objective doesn't rise, which keeps the fit
 * stable when the data are nearly separable.
 */
export function fitLogistic(
  raw: readonly (readonly number[])[],
  labels: readonly number[],
  options: FitOptions = {},
): LogisticFit {
  const lambda = options.lambda ?? 1;
  const maxIterations = options.maxIterations ?? 100;
  const tolerance = options.tolerance ?? 1e-10;
  if (raw.length !== labels.length) throw new RangeError("one label per row");
  const d = raw[0]?.length ?? 0;
  for (const row of raw) {
    if (row.length !== d) throw new RangeError("every row needs the same number of features");
  }
  // Each column's mean and standard deviation; a constant column keeps scale 1.
  const mean = new Array<number>(d).fill(0);
  const scale = new Array<number>(d).fill(1);
  if (options.standardize ?? true) {
    for (let j = 0; j < d; j++) {
      let sum = 0;
      for (const row of raw) sum += row[j] ?? 0;
      const m = raw.length > 0 ? sum / raw.length : 0;
      let squares = 0;
      for (const row of raw) squares += ((row[j] ?? 0) - m) ** 2;
      const sd = raw.length > 0 ? Math.sqrt(squares / raw.length) : 0;
      mean[j] = m;
      scale[j] = sd > 1e-12 ? sd : 1;
    }
  }
  const rows = raw.map((row) => row.map((value, j) => (value - (mean[j] ?? 0)) / (scale[j] ?? 1)));
  const n = d + 1; // the bias, then the weights
  const theta = new Float64Array(n);

  const objective = (params: Float64Array) => {
    let total = 0;
    rows.forEach((row, i) => {
      let z = params[0] ?? 0;
      for (let j = 0; j < d; j++) z += (params[j + 1] ?? 0) * (row[j] ?? 0);
      total += labels[i] === 1 ? softplus(-z) : softplus(z);
    });
    for (let j = 1; j < n; j++) total += (lambda / 2) * (params[j] ?? 0) ** 2;
    return total;
  };

  let current = objective(theta);
  let iterations = 0;
  let converged = false;
  while (iterations < maxIterations) {
    iterations++;
    const gradient = new Float64Array(n);
    const hessian = new Float64Array(n * n);
    const x = new Float64Array(n);
    rows.forEach((row, i) => {
      x[0] = 1;
      for (let j = 0; j < d; j++) x[j + 1] = row[j] ?? 0;
      let z = 0;
      for (let j = 0; j < n; j++) z += (theta[j] ?? 0) * (x[j] ?? 0);
      const p = sigmoid(z);
      const residual = p - (labels[i] === 1 ? 1 : 0);
      const weight = p * (1 - p);
      for (let j = 0; j < n; j++) {
        const xj = x[j] ?? 0;
        gradient[j] = (gradient[j] ?? 0) + residual * xj;
        for (let k = 0; k <= j; k++) {
          hessian[j * n + k] = (hessian[j * n + k] ?? 0) + weight * xj * (x[k] ?? 0);
        }
      }
    });
    for (let j = 0; j < n; j++) {
      for (let k = j + 1; k < n; k++) hessian[j * n + k] = hessian[k * n + j] ?? 0;
    }
    for (let j = 1; j < n; j++) {
      gradient[j] = (gradient[j] ?? 0) + lambda * (theta[j] ?? 0);
      hessian[j * n + j] = (hessian[j * n + j] ?? 0) + lambda;
    }
    const step = solve(hessian, gradient, n);
    let scale = 1;
    let next = new Float64Array(n);
    let value = current;
    for (let halvings = 0; halvings < 30; halvings++) {
      next = theta.map((param, j) => param - scale * (step[j] ?? 0));
      value = objective(next);
      if (value <= current + 1e-12) break;
      scale /= 2;
    }
    let moved = 0;
    for (let j = 0; j < n; j++) moved = Math.max(moved, Math.abs((next[j] ?? 0) - (theta[j] ?? 0)));
    theta.set(next);
    current = value;
    if (moved < tolerance) {
      converged = true;
      break;
    }
  }
  // Back to the raw features: w_j / s_j, and the bias absorbs the means.
  const weights = Array.from(theta.subarray(1), (weight, j) => weight / (scale[j] ?? 1));
  let bias = theta[0] ?? 0;
  weights.forEach((weight, j) => {
    bias -= weight * (mean[j] ?? 0);
  });
  return { bias, weights, iterations, converged, objective: current };
}
