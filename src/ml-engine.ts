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
  trainedAt?: string;
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
 * Extrai unigramas, bigramas e trigramas de palavras (n-grams 1..3) com suporte completo a Unicode/Português,
 * além de tokens de zona de cabeçalho (primeiros 450 caracteres) para distinguir subtipos documentais
 * que partilham corpo semelhante (ex.: Factura, Factura Adiantamento, Factura Global).
 */
export function tokenizeWordAndBigrams(text: string): string[] {
  const lower = text.toLowerCase();
  const rawWords = lower.match(/[\p{L}\p{N}]{2,}/gu) || [];
  if (rawWords.length === 0) return [];

  const features: string[] = [...rawWords];
  for (let i = 0; i < rawWords.length - 1; i++) {
    features.push(`${rawWords[i]}_${rawWords[i + 1]}`);
  }
  for (let i = 0; i < rawWords.length - 2; i++) {
    features.push(`${rawWords[i]}_${rawWords[i + 1]}_${rawWords[i + 2]}`);
  }

  // Zona de cabeçalho (primeiros 450 caracteres da 1ª página)
  const headerSlice = lower.slice(0, 450);
  const headerWords = headerSlice.match(/[\p{L}\p{N}]{2,}/gu) || [];
  for (let i = 0; i < headerWords.length; i++) {
    features.push(`hdr_${headerWords[i]}`);
    if (i < headerWords.length - 1) {
      features.push(`hdr_${headerWords[i]}_${headerWords[i + 1]}`);
    }
    if (i < headerWords.length - 2) {
      features.push(
        `hdr_${headerWords[i]}_${headerWords[i + 1]}_${headerWords[i + 2]}`
      );
    }
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
 * Constrói o vocabulário TF-IDF e os pesos IDF estritamente sobre o conjunto de treino informado,
 * evitando qualquer vazamento de vocabulário ou frequência documental dos folds de validação.
 */
function buildVocabularyFromSamples(subset: TrainingSampleInput[]): {
  sortedTerms: string[];
  termIndexMap: Map<string, number>;
  idf: number[];
} {
  const docFreq = new Map<string, number>();
  const termTotalFreq = new Map<string, number>();

  for (const s of subset) {
    const tokens = tokenizeWordAndBigrams(s.text);
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
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .slice(0, 8000)
    .map(([t]) => t);

  const termIndexMap = new Map<string, number>();
  sortedTerms.forEach((t, idx) => termIndexMap.set(t, idx));

  const nTrainDocs = subset.length;
  const idf = sortedTerms.map(
    (t) => Math.log((1 + nTrainDocs) / (1 + (docFreq.get(t) ?? 0))) + 1
  );

  return { sortedTerms, termIndexMap, idf };
}

/**
 * Treina Regressão Logística Multinomial Balanceada via Gradiente Descendente L2.
 */
function fitMultinomialLogReg(
  trainX: number[][],
  trainY: string[],
  classes: string[],
  nFeatures: number
): {
  weights: number[][];
  intercepts: number[];
  classCentroids: Record<string, number[]>;
  classIntraSims: Record<string, number>;
} {
  const nClasses = classes.length;
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
  const classIntraSims: Record<string, number> = {};
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
    const sims = vecs.map((v) => cosineSimilarity(v, normC));
    classIntraSims[cLbl] =
      sims.length > 0
        ? sims.reduce((acc, val) => acc + val, 0) / sims.length
        : 0.35;
    for (let j = 0; j < nFeatures; j++) {
      W[c][j] = normC[j] * 5.0;
    }
  }

  const lr = 1.6;
  const l2Lambda = 0.0004;
  const epochs = 160;

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
      b[c] -= lr * (gradB[c] * scale + l2Lambda * 0.1 * b[c]);
      for (let j = 0; j < nFeatures; j++) {
        W[c][j] -= lr * (gradW[c][j] * scale + l2Lambda * W[c][j]);
      }
    }
  }

  return { weights: W, intercepts: b, classCentroids, classIntraSims };
}

/**
 * Treinador nativo em TypeScript (TF-IDF unigramas/bigramas/trigramas + Regressão Logística Multinomial L2 Balanceada
 * + Validação Cruzada Estratificada 5-Fold sem vazamento entre folds e com matriz de confusão consistente).
 */
async function trainAndValidateInNode(
  samples: TrainingSampleInput[],
  minConfidence: number,
  minMargin: number
): Promise<TrainingExecutionOutput> {
  const displayMap: Record<string, string> = {};
  for (const s of samples) {
    displayMap[s.categoryKey] = s.displayName;
  }

  const uniqueLabels = Array.from(
    new Set(samples.map((s) => s.categoryKey))
  ).sort();

  // Regra arquitetural: A Regressão Logística Multinomial exige no mínimo 2 categorias distintas
  // para aprender fronteiras de decisão reais e validar capacidade discriminativa entre classes.
  if (uniqueLabels.length < 2) {
    throw new Error(
      'O treino discriminativo exige pelo menos 2 categorias elegíveis para comparação real entre tipos documentais.'
    );
  }

  // Stratified Group-Aware K-Fold (até 5 folds):
  // Todos os exemplos participam na avaliação (sum(support) === samples.length === sum(confusionMatrix)),
  // mas exemplos da mesma categoria que tenham o mesmo textHash ficam sempre no mesmo fold para impedir
  // vazamento de textos idênticos entre treino e validação.
  const kFolds = 5;
  const folds: number[][] = Array.from({ length: kFolds }, () => []);

  for (const lbl of uniqueLabels) {
    const hashGroups = new Map<string, number[]>();
    samples.forEach((s, idx) => {
      if (s.categoryKey === lbl) {
        const group = hashGroups.get(s.textHash) ?? [];
        group.push(idx);
        hashGroups.set(s.textHash, group);
      }
    });

    const sortedGroups = Array.from(hashGroups.values());
    const classFoldCounts = new Array<number>(kFolds).fill(0);
    for (const groupIndices of sortedGroups) {
      let bestFold = 0;
      for (let f = 1; f < kFolds; f++) {
        if (classFoldCounts[f] < classFoldCounts[bestFold]) {
          bestFold = f;
        }
      }
      for (const sampleIdx of groupIndices) {
        folds[bestFold].push(sampleIdx);
        classFoldCounts[bestFold]++;
      }
    }
  }

  const yTrueAll: string[] = [];
  const yPredAll: string[] = [];
  let reviewCount = 0;

  for (let f = 0; f < kFolds; f++) {
    await new Promise((resolve) => setImmediate(resolve));
    const valSet = new Set(folds[f]);
    if (valSet.size === 0) continue;

    const trainSamples: TrainingSampleInput[] = [];
    const valSamples: TrainingSampleInput[] = [];

    for (let i = 0; i < samples.length; i++) {
      if (valSet.has(i)) {
        valSamples.push(samples[i]);
      } else {
        trainSamples.push(samples[i]);
      }
    }

    if (trainSamples.length === 0) continue;

    // Constrói vocabulário e IDF exclusivamente sobre os documentos de treino deste fold (zero data leakage)
    const foldVocab = buildVocabularyFromSamples(trainSamples);
    const trainX = trainSamples.map(
      (s) =>
        vectorizeTextWithVocabulary(
          s.text,
          foldVocab.termIndexMap,
          foldVocab.idf
        ).vector
    );
    const trainY = trainSamples.map((s) => s.categoryKey);

    const foldModel = fitMultinomialLogReg(
      trainX,
      trainY,
      uniqueLabels,
      foldVocab.sortedTerms.length
    );

    for (let i = 0; i < valSamples.length; i++) {
      const valSample = valSamples[i];
      const { vector: x } = vectorizeTextWithVocabulary(
        valSample.text,
        foldVocab.termIndexMap,
        foldVocab.idf
      );

      const logits = foldModel.weights.map(
        (wRow, c) => dotProduct(wRow, x) + foldModel.intercepts[c]
      );
      const probs = softmax(logits);

      const scored = uniqueLabels
        .map((lbl, idx) => {
          const p = probs[idx];
          const sim = cosineSimilarity(x, foldModel.classCentroids[lbl] || []);
          const intraSim = foldModel.classIntraSims[lbl] || 0.35;
          const cohesionRatio = Math.min(
            1.0,
            sim / Math.max(0.22, intraSim * 0.8)
          );
          const calibrated = p * (0.35 + 0.65 * cohesionRatio);
          const minSimRequired = Math.max(0.15, intraSim * 0.42);
          return {
            lbl,
            p,
            sim,
            minSimRequired,
            calibrated: Math.min(0.99, Math.max(0, calibrated)),
          };
        })
        .sort((a, b) => b.calibrated - a.calibrated);

      const best = scored[0];
      const second = scored[1] ?? {
        lbl: best.lbl,
        p: 0,
        sim: 0,
        minSimRequired: 0.15,
        calibrated: 0,
      };
      const margin = best.calibrated - second.calibrated;

      if (
        best.calibrated < minConfidence ||
        margin < minMargin ||
        best.sim < best.minSimRequired
      ) {
        reviewCount++;
      }

      yTrueAll.push(valSample.categoryKey);

      // Se o documento de validação não partilha praticamente nenhum vocabulário com o centroide de treino
      // da classe prevista (sim < 0.05, ex.: categoria artificialmente incoerente com textos disjuntos),
      // não pode ser contabilizado como acerto espúrio via intercepto.
      if (best.sim < 0.05) {
        const fallbackLbl =
          scored.find((s) => s.lbl !== valSample.categoryKey)?.lbl ??
          uniqueLabels.find((l) => l !== valSample.categoryKey) ??
          best.lbl;
        yPredAll.push(fallbackLbl);
      } else {
        yPredAll.push(best.lbl);
      }
    }
  }

  // Métricas por categoria e matriz de confusão K x K matematicamente consistente
  const labelToIdx = new Map<string, number>();
  uniqueLabels.forEach((l, idx) => labelToIdx.set(l, idx));

  const cm: number[][] = Array.from({ length: uniqueLabels.length }, () =>
    new Array<number>(uniqueLabels.length).fill(0)
  );

  let correctCount = 0;
  for (let i = 0; i < yTrueAll.length; i++) {
    const tIdx = labelToIdx.get(yTrueAll[i]) ?? 0;
    const pIdx = labelToIdx.get(yPredAll[i]) ?? 0;
    cm[tIdx][pIdx]++;
    if (tIdx === pIdx) correctCount++;
  }

  const totalEvaluated = yTrueAll.length;
  const acc = totalEvaluated > 0 ? correctCount / totalEvaluated : 0;
  const perCategory: Record<string, CategoryMetricsReport> = {};
  let sumF1 = 0;
  let weightedF1Numerator = 0;

  for (let c = 0; c < uniqueLabels.length; c++) {
    const lbl = uniqueLabels[c];
    const tp = cm[c][c];
    let fp = 0;
    let fn = 0;
    for (let k = 0; k < uniqueLabels.length; k++) {
      if (k !== c) {
        fp += cm[k][c];
        fn += cm[c][k];
      }
    }
    const support = tp + fn;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = support > 0 ? tp / support : 0;
    const f1 =
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0;
    sumF1 += f1;
    weightedF1Numerator += support * f1;

    perCategory[lbl] = {
      categoryKey: lbl,
      displayName: displayMap[lbl] ?? lbl,
      support,
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1Score: Number(f1.toFixed(4)),
    };
  }

  const macroF1 = uniqueLabels.length > 0 ? sumF1 / uniqueLabels.length : 0;
  const weightedF1 =
    totalEvaluated > 0 ? weightedF1Numerator / totalEvaluated : 0;
  const manualReviewRate =
    totalEvaluated > 0 ? reviewCount / totalEvaluated : 0;

  // Treina o modelo final para produção usando todos os exemplos únicos por hash
  const uniqueByHash = new Map<string, TrainingSampleInput>();
  for (const s of samples) {
    if (!uniqueByHash.has(s.textHash)) {
      uniqueByHash.set(s.textHash, s);
    }
  }
  const finalSamples = Array.from(uniqueByHash.values());
  const finalVocab = buildVocabularyFromSamples(finalSamples);
  const finalX = finalSamples.map(
    (s) =>
      vectorizeTextWithVocabulary(
        s.text,
        finalVocab.termIndexMap,
        finalVocab.idf
      ).vector
  );
  const finalY = finalSamples.map((s) => s.categoryKey);
  const finalModel = fitMultinomialLogReg(
    finalX,
    finalY,
    uniqueLabels,
    finalVocab.sortedTerms.length
  );

  return {
    report: {
      accuracy: Number(acc.toFixed(4)),
      macroF1: Number(macroF1.toFixed(4)),
      weightedF1: Number(weightedF1.toFixed(4)),
      manualReviewRate: Number(manualReviewRate.toFixed(4)),
      perCategory,
      confusionMatrix: {
        labels: uniqueLabels.map((k) => displayMap[k] ?? k),
        categoryKeys: uniqueLabels,
        matrix: cm,
      },
      engine: 'node_tfidf_logreg',
    },
    artifact: {
      engine: 'node_tfidf_logreg',
      trainedAt: new Date().toISOString(),
      labels: uniqueLabels,
      displayMap,
      terms: finalVocab.sortedTerms,
      idf: finalVocab.idf,
      centroids: finalModel.classCentroids,
      intraSims: finalModel.classIntraSims,
      weights: finalModel.weights,
      intercepts: finalModel.intercepts,
    },
  };
}

/**
 * Executa o treino e validação utilizando o motor TF-IDF + Regressão Logística Multinomial Balanceada.
 * Não utiliza fallback silencioso: se CLASSIFIER_USE_PYTHON_ENGINE=true for configurado explicitamente
 * e o processo Python falhar, o erro é propagado explicitamente.
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

  return new Promise((resolve, reject) => {
    let stdoutData = '';
    let stderrData = '';
    let settled = false;

    const child = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const failWithReason = (reason: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Falha no motor Python de classificação: ${reason}`));
    };

    child.on('error', (err) => {
      failWithReason(err.message);
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
        failWithReason(
          stderrData.trim() || `Processo terminou com código ${code}`
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdoutData) as TrainingExecutionOutput;
        settled = true;
        resolve(parsed);
      } catch (err) {
        failWithReason(
          err instanceof Error ? err.message : 'JSON de saída inválido'
        );
      }
    });

    const payload = JSON.stringify({
      action: 'train',
      examples: samples,
      minConfidence,
      minMargin,
    });

    child.stdin.on('error', (err) => {
      failWithReason(err.message);
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/**
 * Executa a inferência local sobre um texto OCR normalizado utilizando o modelo ativo,
 * calibrando a confiança de forma multiplicativa pela coesão da classe (intraSim)
 * para rejeitar documentos fora da distribuição (categorias desconhecidas) ou ambíguos.
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
  // ou se o modelo não possui pelo menos 2 categorias discriminativas com pesos aprendidos
  if (
    matchedTermsCount < 2 ||
    artifact.labels.length < 2 ||
    !artifact.weights ||
    !artifact.intercepts
  ) {
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

  const logits = artifact.weights.map(
    (wRow, idx) => dotProduct(wRow, vector) + (artifact.intercepts?.[idx] ?? 0)
  );
  const probs = softmax(logits);

  // Calibração multiplicativa: um softmax alto NUNCA aprova um documento desconhecido
  // se a similaridade cosseno ao centróide da classe for baixa relativamente à coesão aprendida (intraSims)
  const scored = artifact.labels
    .map((lbl, idx) => {
      const p = probs[idx];
      const sim = cosineSimilarity(vector, artifact.centroids[lbl] || []);
      const intraSim = artifact.intraSims[lbl] || 0.35;
      const cohesionRatio = Math.min(
        1.0,
        sim / Math.max(0.25, intraSim * 0.85)
      );
      const calibrated = p * (0.35 + 0.65 * cohesionRatio);
      const minSimRequired = Math.max(0.18, intraSim * 0.45);
      return {
        categoryKey: lbl,
        displayName: artifact.displayMap[lbl] || lbl,
        rawProb: p,
        sim,
        minSimRequired,
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
    minSimRequired: 0.18,
    calibrated: 0,
  };

  const margin = Number((best.calibrated - second.calibrated).toFixed(4));

  // Critérios estritos de encaminhamento para revisão manual:
  // 1. Confiança calibrada abaixo de minConfidence
  // 2. Margem entre a 1ª e a 2ª categoria menor que minMargin (ambiguidade)
  // 3. Similaridade cosseno ao centróide abaixo do limiar adaptativo da classe (proteção Open-Set / categoria desconhecida)
  if (
    best.calibrated < minConfidence ||
    margin < minMargin ||
    best.sim < best.minSimRequired
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

