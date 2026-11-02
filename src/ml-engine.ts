import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import type {
  CategoryMetricsReport,
  ModelValidationReport,
} from './types.js';

export interface TrainingSampleInput {
  id: number;
  categoryKey: string;
  displayName: string;
  text: string;
  textHash: string;
}

export interface TrainedModelArtifact {
  engine: 'python_sklearn' | 'node_tfidf_logreg';
  labels: string[];
  displayMap: Record<string, string>;
  terms: string[];
  idf: number[];
  centroids: Record<string, number[]>;
  intraSims: Record<string, number>;
  weights: number[][] | null;
  intercepts: number[] | null;
}

export interface TrainingExecutionOutput {
  report: ModelValidationReport;
  artifact: TrainedModelArtifact;
}

export interface PredictionResult {
  status: 'classified' | 'needs_review';
  documentType: string | null;
  categoryKey: string | null;
  confidence: number;
  requiresManualReview: boolean;
  secondBestDocumentType: string | null;
  secondBestConfidence: number | null;
  margin: number;
  centroidSimilarity: number;
}

/**
 * Normaliza o nome de uma categoria para evitar duplicações acidentais por capitalização,
 * múltiplos espaços ou variações de acentuação na chave interna, preservando um nome de
 * apresentação legível e estável e mantendo categorias semanticamente distintas separadas.
 */
export function normalizeCategoryName(rawCategory: string): {
  categoryKey: string;
  displayName: string;
} {
  const cleanedDisplay = rawCategory
    .replace(/\s+/g, ' ')
    .trim();

  // Se o texto vier todo em MAIÚSCULAS (ex: "FATURA DE ADIANTAMENTO"), converte para Title Case legível
  const isAllUpper =
    cleanedDisplay.length > 2 &&
    cleanedDisplay === cleanedDisplay.toUpperCase() &&
    cleanedDisplay !== cleanedDisplay.toLowerCase();

  const lowercaseParticles = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'para', 'com']);

  const displayName = isAllUpper
    ? cleanedDisplay
        .toLowerCase()
        .split(' ')
        .map((word, idx) =>
          idx > 0 && lowercaseParticles.has(word)
            ? word
            : word.charAt(0).toUpperCase() + word.slice(1)
        )
        .join(' ')
    : cleanedDisplay.charAt(0).toUpperCase() + cleanedDisplay.slice(1);

  const categoryKey = cleanedDisplay
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return {
    categoryKey,
    displayName,
  };
}

/**
 * Normaliza o texto OCR para o motor de Machine Learning:
 * - Preserva letras acentuadas do português e números
 * - Corrige ruídos comuns de OCR (múltiplos espaços, hifens quebrados)
 * - Gera também o hash SHA-256 canônico para deduplicação de exemplos
 */
export function preprocessOcrForMl(rawText: string): {
  normalizedText: string;
  textHash: string;
  tokenCount: number;
} {
  const normalizedText = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/-\n(\p{L})/gu, '$1')
    .replace(/[^\p{L}\p{N}\s.,:/()-]/gu, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  const tokens = tokenizeWordAndBigrams(normalizedText);
  const canonicalForHash = normalizedText
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const textHash = crypto
    .createHash('sha256')
    .update(canonicalForHash, 'utf8')
    .digest('hex');

  return {
    normalizedText,
    textHash,
    tokenCount: tokens.length,
  };
}

/**
 * Extrai unigramas e bigramas de palavras (n-grams 1..2) com suporte completo a Unicode/Português.
 */
export function tokenizeWordAndBigrams(text: string): string[] {
  const lower = text.toLowerCase();
  const rawWords = lower.match(/[\p{L}\p{N}]{2,}/gu) || [];
  if (rawWords.length === 0) return [];

  const features: string[] = [...rawWords];
  for (let i = 0; i < rawWords.length - 1; i++) {
    features.push(`${rawWords[i]}_${rawWords[i + 1]}`);
  }
  return features;
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm <= 1e-12) return vec;
  return vec.map((v) => v / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let normA = 0;
  let normB = 0;
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom <= 1e-12) return 0;
  return dot / denom;
}

function softmax(logits: number[]): number[] {
  const maxLogit = Math.max(...logits);
  const exps = logits.map((z) => Math.exp(z - maxLogit));
  const sumExps = exps.reduce((acc, val) => acc + val, 0);
  return exps.map((e) => e / (sumExps || 1));
}

/**
 * Converte um texto num vetor TF-IDF L2-normalizado usando o vocabulário e IDF aprendidos.
 */
export function vectorizeTextWithVocabulary(
  text: string,
  termIndexMap: Map<string, number>,
  idf: number[]
): { vector: number[]; matchedTermsCount: number } {
  const tokens = tokenizeWordAndBigrams(text);
  const tfCounts = new Map<number, number>();

  for (const token of tokens) {
    const idx = termIndexMap.get(token);
    if (idx !== undefined) {
      tfCounts.set(idx, (tfCounts.get(idx) ?? 0) + 1);
    }
  }

  const vec = new Array<number>(idf.length).fill(0);
  for (const [idx, count] of tfCounts.entries()) {
    // Sublinear TF: 1 + ln(tf)
    vec[idx] = (1 + Math.log(count)) * idf[idx];
  }

  return {
    vector: l2Normalize(vec),
    matchedTermsCount: tfCounts.size,
  };
}

/**
 * Treinador nativo em TypeScript (TF-IDF unigramas/bigramas + Regressão Logística Multinomial L2 Balanceada
 + Validação Cruzada Estratificada K-Fold).
 * Utilizado automaticamente quando o binário Python/scikit-learn não está disponível no ambiente local.
 */
function trainAndValidateInNode(
  samples: TrainingSampleInput[],
  minConfidence: number,
  minMargin: number
): TrainingExecutionOutput {
  // Deduplicação por textHash para evitar vazamento entre treino e validação
  const uniqueByHash = new Map<string, TrainingSampleInput>();
  for (const s of samples) {
    if (!uniqueByHash.has(s.textHash)) {
      uniqueByHash.set(s.textHash, s);
    }
  }
  const dedupSamples = Array.from(uniqueByHash.values());
  const displayMap: Record<string, string> = {};
  for (const s of samples) {
    displayMap[s.categoryKey] = s.displayName;
  }

  const uniqueLabels = Array.from(
    new Set(dedupSamples.map((s) => s.categoryKey))
  ).sort();

  // Construção do vocabulário TF-IDF (até 6000 termos mais frequentes)
  const docFreq = new Map<string, number>();
  const termTotalFreq = new Map<string, number>();
  const tokenizedDocs = dedupSamples.map((s) => tokenizeWordAndBigrams(s.text));

  for (const tokens of tokenizedDocs) {
    const seenInDoc = new Set<string>();
    for (const t of tokens) {
      termTotalFreq.set(t, (termTotalFreq.get(t) ?? 0) + 1);
      if (!seenInDoc.has(t)) {
        seenInDoc.add(t);
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
    }
  }

  const sortedTerms = Array.from(termTotalFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6000)
    .map(([t]) => t);

  const termIndexMap = new Map<string, number>();
  sortedTerms.forEach((t, idx) => termIndexMap.set(t, idx));

  const nDocs = dedupSamples.length;
  const idf = sortedTerms.map(
    (t) => Math.log((1 + nDocs) / (1 + (docFreq.get(t) ?? 0))) + 1
  );

  const X = dedupSamples.map(
    (s) => vectorizeTextWithVocabulary(s.text, termIndexMap, idf).vector
  );
  const y = dedupSamples.map((s) => s.categoryKey);

  // Calcula centróides e coesão intra-classe
  const centroids: Record<string, number[]> = {};
  const intraSims: Record<string, number> = {};

  for (const lbl of uniqueLabels) {
    const classVecs = X.filter((_, idx) => y[idx] === lbl);
    const dim = sortedTerms.length;
    const mean = new Array<number>(dim).fill(0);
    for (const v of classVecs) {
      for (let j = 0; j < dim; j++) {
        mean[j] += v[j];
      }
    }
    const normMean = l2Normalize(mean);
    centroids[lbl] = normMean;
    const sims = classVecs.map((v) => cosineSimilarity(v, normMean));
    intraSims[lbl] =
      sims.length > 0
        ? sims.reduce((acc, v) => acc + v, 0) / sims.length
        : 0;
  }

  // Caso 1: Apenas 1 categoria elegível (>= 10 exemplos) -> Validação 5-Fold de Coesão
  if (uniqueLabels.length === 1) {
    const lbl = uniqueLabels[0];
    const kFolds = Math.min(5, nDocs);
    const foldSize = Math.max(1, Math.floor(nDocs / kFolds));
    let heldOutRight = 0;
    let reviewCount = 0;

    for (let f = 0; f < kFolds; f++) {
      const start = f * foldSize;
      const end = f === kFolds - 1 ? nDocs : (f + 1) * foldSize;
      const trainVecs: number[][] = [];
      const valVecs: number[][] = [];

      for (let i = 0; i < nDocs; i++) {
        if (i >= start && i < end) {
          valVecs.push(X[i]);
        } else {
          trainVecs.push(X[i]);
        }
      }

      const dim = sortedTerms.length;
      const trMean = new Array<number>(dim).fill(0);
      for (const v of trainVecs) {
        for (let j = 0; j < dim; j++) trMean[j] += v[j];
      }
      const trCentroid = l2Normalize(trMean);

      for (const v of valVecs) {
        const sim = cosineSimilarity(v, trCentroid);
        const conf = Math.min(0.99, Math.max(0, (sim - 0.05) / 0.45));
        if (conf >= minConfidence) {
          heldOutRight++;
        } else {
          reviewCount++;
        }
      }
    }

    const acc = nDocs > 0 ? heldOutRight / nDocs : 0;
    const f1Val = acc > 0 ? (2 * acc) / (1 + acc) : 0;
    const reviewRate = nDocs > 0 ? reviewCount / nDocs : 1;

    return {
      report: {
        accuracy: Number(acc.toFixed(4)),
        macroF1: Number(f1Val.toFixed(4)),
        manualReviewRate: Number(reviewRate.toFixed(4)),
        perCategory: {
          [lbl]: {
            categoryKey: lbl,
            displayName: displayMap[lbl],
            support: samples.length,
            precision: heldOutRight > 0 ? 1 : 0,
            recall: Number(acc.toFixed(4)),
            f1Score: Number(f1Val.toFixed(4)),
          },
        },
        confusionMatrix: {
          labels: uniqueLabels,
          matrix: [[heldOutRight]],
        },
        engine: 'node_tfidf_logreg',
      },
      artifact: {
        engine: 'node_tfidf_logreg',
        labels: uniqueLabels,
        displayMap,
        terms: sortedTerms,
        idf,
        centroids,
        intraSims,
        weights: null,
        intercepts: null,
      },
    };
  }

  // Função interna para treinar Regressão Logística Multinomial Balanceada via Gradiente Descendente L2
  function fitMultinomialLogReg(
    trainX: number[][],
    trainY: string[],
    classes: string[]
  ): { weights: number[][]; intercepts: number[]; classCentroids: Record<string, number[]> } {
    const nClasses = classes.length;
    const nFeatures = sortedTerms.length;
    const nSamples = trainX.length;

    const classToIdx = new Map<string, number>();
    classes.forEach((c, idx) => classToIdx.set(c, idx));

    // Pesos de balanceamento de classe inversamente proporcionais à frequência
    const classCounts = new Array<number>(nClasses).fill(0);
    for (const yVal of trainY) {
      const cIdx = classToIdx.get(yVal) ?? 0;
      classCounts[cIdx]++;
    }
    const classWeights = classCounts.map((cnt) =>
      cnt > 0 ? nSamples / (nClasses * cnt) : 1
    );

    // Inicializa pesos com os centróides escalados para convergência rápida e determinística
    const classCentroids: Record<string, number[]> = {};
    const W: number[][] = Array.from({ length: nClasses }, () =>
      new Array<number>(nFeatures).fill(0)
    );
    const b = new Array<number>(nClasses).fill(0);

    for (let c = 0; c < nClasses; c++) {
      const cLbl = classes[c];
      const vecs = trainX.filter((_, idx) => trainY[idx] === cLbl);
      const mean = new Array<number>(nFeatures).fill(0);
      for (const v of vecs) {
        for (let j = 0; j < nFeatures; j++) mean[j] += v[j];
      }
      const normC = l2Normalize(mean);
      classCentroids[cLbl] = normC;
      for (let j = 0; j < nFeatures; j++) {
        W[c][j] = normC[j] * 4.0;
      }
    }

    const lr = 0.8;
    const l2Lambda = 0.005;
    const epochs = 80;

    for (let epoch = 0; epoch < epochs; epoch++) {
      const gradW: number[][] = Array.from({ length: nClasses }, () =>
        new Array<number>(nFeatures).fill(0)
      );
      const gradB = new Array<number>(nClasses).fill(0);

      for (let i = 0; i < nSamples; i++) {
        const x = trainX[i];
        const targetClass = classToIdx.get(trainY[i]) ?? 0;
        const sampleWeight = classWeights[targetClass];

        const logits = W.map((wRow, c) => dotProduct(wRow, x) + b[c]);
        const probs = softmax(logits);

        for (let c = 0; c < nClasses; c++) {
          const diff = (probs[c] - (c === targetClass ? 1 : 0)) * sampleWeight;
          gradB[c] += diff;
          for (let j = 0; j < nFeatures; j++) {
            if (x[j] !== 0) {
              gradW[c][j] += diff * x[j];
            }
          }
        }
      }

      const scale = 1 / nSamples;
      for (let c = 0; c < nClasses; c++) {
        b[c] -= lr * gradB[c] * scale;
        for (let j = 0; j < nFeatures; j++) {
          W[c][j] -= lr * (gradW[c][j] * scale + l2Lambda * W[c][j]);
        }
      }
    }

    return { weights: W, intercepts: b, classCentroids };
  }

  // Stratified K-Fold (até 5 folds)
  const kFolds = 5;
  const folds: number[][] = Array.from({ length: kFolds }, () => []);
  for (const lbl of uniqueLabels) {
    const indices = y
      .map((val, idx) => (val === lbl ? idx : -1))
      .filter((idx) => idx >= 0);
    indices.forEach((sampleIdx, pos) => {
      folds[pos % kFolds].push(sampleIdx);
    });
  }

  const yTrueAll: string[] = [];
  const yPredAll: string[] = [];
  let reviewCount = 0;

  for (let f = 0; f < kFolds; f++) {
    const valSet = new Set(folds[f]);
    if (valSet.size === 0) continue;

    const trainX: number[][] = [];
    const trainY: string[] = [];
    const valX: number[][] = [];
    const valY: string[] = [];

    for (let i = 0; i < nDocs; i++) {
      if (valSet.has(i)) {
        valX.push(X[i]);
        valY.push(y[i]);
      } else {
        trainX.push(X[i]);
        trainY.push(y[i]);
      }
    }

    if (trainX.length === 0) continue;

    const foldModel = fitMultinomialLogReg(trainX, trainY, uniqueLabels);

    for (let i = 0; i < valX.length; i++) {
      const x = valX[i];
      const logits = foldModel.weights.map(
        (wRow, c) => dotProduct(wRow, x) + foldModel.intercepts[c]
      );
      const probs = softmax(logits);

      const scored = uniqueLabels
        .map((lbl, idx) => {
          const p = probs[idx];
          const sim = cosineSimilarity(x, foldModel.classCentroids[lbl] || []);
          const calibrated = 0.65 * p + 0.35 * Math.min(1.0, sim / 0.35);
          return {
            lbl,
            p,
            sim,
            calibrated: Math.min(0.99, Math.max(0, calibrated)),
          };
        })
        .sort((a, b) => b.calibrated - a.calibrated);

      const best = scored[0];
      const second = scored[1] ?? {
        lbl: best.lbl,
        p: 0,
        sim: 0,
        calibrated: 0,
      };
      const margin = best.calibrated - second.calibrated;

      yTrueAll.push(valY[i]);
      if (
        best.calibrated < minConfidence ||
        margin < minMargin ||
        best.sim < 0.15
      ) {
        reviewCount++;
        yPredAll.push('__needs_review__');
      } else {
        yPredAll.push(best.lbl);
      }
    }
  }

  // Métricas por categoria e matriz de confusão
  const labelToIdx = new Map<string, number>();
  uniqueLabels.forEach((l, idx) => labelToIdx.set(l, idx));

  const cm: number[][] = Array.from({ length: uniqueLabels.length }, () =>
    new Array<number>(uniqueLabels.length).fill(0)
  );
  const fnUnclassified = new Array<number>(uniqueLabels.length).fill(0);

  let correctCount = 0;
  for (let i = 0; i < yTrueAll.length; i++) {
    const tIdx = labelToIdx.get(yTrueAll[i]) ?? 0;
    const predLbl = yPredAll[i];
    if (predLbl === '__needs_review__') {
      fnUnclassified[tIdx]++;
      continue;
    }
    const pIdx = labelToIdx.get(predLbl) ?? 0;
    cm[tIdx][pIdx]++;
    if (tIdx === pIdx) correctCount++;
  }

  const acc = yTrueAll.length > 0 ? correctCount / yTrueAll.length : 0;
  const perCategory: Record<string, CategoryMetricsReport> = {};
  let sumF1 = 0;

  for (let c = 0; c < uniqueLabels.length; c++) {
    const lbl = uniqueLabels[c];
    const tp = cm[c][c];
    let fp = 0;
    let fn = fnUnclassified[c];
    for (let k = 0; k < uniqueLabels.length; k++) {
      if (k !== c) {
        fp += cm[k][c];
        fn += cm[c][k];
      }
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 =
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0;
    sumF1 += f1;

    perCategory[lbl] = {
      categoryKey: lbl,
      displayName: displayMap[lbl],
      support: samples.filter((s) => s.categoryKey === lbl).length,
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1Score: Number(f1.toFixed(4)),
    };
  }

  const macroF1 = uniqueLabels.length > 0 ? sumF1 / uniqueLabels.length : 0;
  const manualReviewRate =
    yTrueAll.length > 0 ? reviewCount / yTrueAll.length : 0;

  // Treina modelo final com todos os exemplos deduplicados
  const finalModel = fitMultinomialLogReg(X, y, uniqueLabels);

  return {
    report: {
      accuracy: Number(acc.toFixed(4)),
      macroF1: Number(macroF1.toFixed(4)),
      manualReviewRate: Number(manualReviewRate.toFixed(4)),
      perCategory,
      confusionMatrix: {
        labels: uniqueLabels,
        matrix: cm,
      },
      engine: 'node_tfidf_logreg',
    },
    artifact: {
      engine: 'node_tfidf_logreg',
      labels: uniqueLabels,
      displayMap,
      terms: sortedTerms,
      idf,
      centroids: finalModel.classCentroids,
      intraSims,
      weights: finalModel.weights,
      intercepts: finalModel.intercepts,
    },
  };
}

/**
 * Executa o treino e validação tentando primeiramente o motor Python (scikit-learn)
 * e utilizando o motor TF-IDF + Regressão Logística em Node caso Python não esteja instalado no host.
 */
export async function executeModelTraining(
  samples: TrainingSampleInput[],
  minConfidence = config.classifierMinConfidence,
  minMargin = config.classifierMinMargin
): Promise<TrainingExecutionOutput> {
  if (!config.classifierUsePythonEngine) {
    return trainAndValidateInNode(samples, minConfidence, minMargin);
  }

  const scriptPath = path.resolve(process.cwd(), 'ml', 'classifier_engine.py');

  return new Promise((resolve) => {
    let stdoutData = '';
    let stderrData = '';
    let settled = false;

    const child = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const fallbackToNode = () => {
      if (settled) return;
      settled = true;
      resolve(trainAndValidateInNode(samples, minConfidence, minMargin));
    };

    child.on('error', () => {
      fallbackToNode();
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutData += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrData += chunk.toString('utf8');
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0 || !stdoutData.trim()) {
        void stderrData;
        fallbackToNode();
        return;
      }
      try {
        const parsed = JSON.parse(stdoutData) as TrainingExecutionOutput;
        settled = true;
        resolve(parsed);
      } catch {
        fallbackToNode();
      }
    });

    const payload = JSON.stringify({
      action: 'train',
      examples: samples,
      minConfidence,
      minMargin,
    });

    child.stdin.on('error', () => {
      fallbackToNode();
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/**
 * Executa a inferência local sobre um texto OCR normalizado utilizando o modelo ativo,
 * calibrando a confiança e avaliando ambiguidade/revisão manual.
 */
export function predictWithModelArtifact(
  normalizedText: string,
  artifact: TrainedModelArtifact,
  minConfidence = config.classifierMinConfidence,
  minMargin = config.classifierMinMargin
): PredictionResult {
  const termIndexMap = new Map<string, number>();
  artifact.terms.forEach((t, idx) => termIndexMap.set(t, idx));

  const { vector, matchedTermsCount } = vectorizeTextWithVocabulary(
    normalizedText,
    termIndexMap,
    artifact.idf
  );

  // Se o documento praticamente não compartilha vocabulário com nenhuma categoria conhecida
  if (matchedTermsCount < 2) {
    return {
      status: 'needs_review',
      documentType: null,
      categoryKey: null,
      confidence: 0,
      requiresManualReview: true,
      secondBestDocumentType: null,
      secondBestConfidence: null,
      margin: 0,
      centroidSimilarity: 0,
    };
  }

  // Caso 1: Modelo de classe única (1 categoria ativa) -> avaliação via similaridade cosseno com centróide
  if (
    artifact.labels.length === 1 ||
    !artifact.weights ||
    !artifact.intercepts
  ) {
    const lbl = artifact.labels[0];
    const centroid = artifact.centroids[lbl] || [];
    const sim = cosineSimilarity(vector, centroid);
    const calibratedConf = Number(
      Math.min(0.99, Math.max(0, (sim - 0.05) / 0.45)).toFixed(4)
    );

    if (calibratedConf < minConfidence || sim < 0.18) {
      return {
        status: 'needs_review',
        documentType: null,
        categoryKey: null,
        confidence: calibratedConf,
        requiresManualReview: true,
        secondBestDocumentType: null,
        secondBestConfidence: null,
        margin: calibratedConf,
        centroidSimilarity: Number(sim.toFixed(4)),
      };
    }

    return {
      status: 'classified',
      documentType: artifact.displayMap[lbl] || lbl,
      categoryKey: lbl,
      confidence: calibratedConf,
      requiresManualReview: false,
      secondBestDocumentType: null,
      secondBestConfidence: null,
      margin: calibratedConf,
      centroidSimilarity: Number(sim.toFixed(4)),
    };
  }

  // Caso 2: Modelo multi-classe (>= 2 categorias ativas)
  const logits = artifact.weights.map(
    (wRow, idx) => dotProduct(wRow, vector) + (artifact.intercepts?.[idx] ?? 0)
  );
  const probs = softmax(logits);

  // Combina probabilidade discriminativa (Regressão Logística) com similaridade cosseno ao centróide da classe
  const scored = artifact.labels
    .map((lbl, idx) => {
      const p = probs[idx];
      const sim = cosineSimilarity(vector, artifact.centroids[lbl] || []);
      const calibrated = 0.65 * p + 0.35 * Math.min(1.0, sim / 0.35);
      return {
        categoryKey: lbl,
        displayName: artifact.displayMap[lbl] || lbl,
        rawProb: p,
        sim,
        calibrated: Number(Math.min(0.99, Math.max(0, calibrated)).toFixed(4)),
      };
    })
    .sort((a, b) => b.calibrated - a.calibrated);

  const best = scored[0];
  const second = scored[1] ?? {
    categoryKey: null,
    displayName: null,
    rawProb: 0,
    sim: 0,
    calibrated: 0,
  };

  const margin = Number((best.calibrated - second.calibrated).toFixed(4));

  // Critérios de rejeição / encaminhamento para revisão manual:
  // 1. Confiança calibrada abaixo de minConfidence
  // 2. Margem entre a 1ª e a 2ª categoria menor que minMargin (ambiguidade ex: Fatura vs Nota de Crédito)
  // 3. Similaridade cosseno ao centróide muito baixa (documento fora da distribuição conhecida)
  if (
    best.calibrated < minConfidence ||
    margin < minMargin ||
    best.sim < 0.10
  ) {
    return {
      status: 'needs_review',
      documentType: null,
      categoryKey: null,
      confidence: best.calibrated,
      requiresManualReview: true,
      secondBestDocumentType: second.displayName,
      secondBestConfidence: second.calibrated,
      margin,
      centroidSimilarity: Number(best.sim.toFixed(4)),
    };
  }

  return {
    status: 'classified',
    documentType: best.displayName,
    categoryKey: best.categoryKey,
    confidence: best.calibrated,
    requiresManualReview: false,
    secondBestDocumentType: second.displayName,
    secondBestConfidence: second.calibrated,
    margin,
    centroidSimilarity: Number(best.sim.toFixed(4)),
  };
}

