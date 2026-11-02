#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Motor de Classificação Supervisionada Local (scikit-learn)
Universal Document AI Gateway — DocuWare Cloud 7.14
Utiliza TF-IDF (word n-grams 1..2 + char_wb n-grams 3..5) + LogisticRegression balanceada
e protótipos de similaridade cosseno para calibração e deteção de ambiguidade/OOD.
"""

import sys
import json
import math
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import precision_recall_fscore_support, confusion_matrix, accuracy_score
from sklearn.preprocessing import normalize


def compute_cosine_sim(vec_a, vec_b):
    denom = (np.linalg.norm(vec_a) * np.linalg.norm(vec_b))
    if denom <= 1e-12:
        return 0.0
    return float(np.dot(vec_a, vec_b) / denom)


def train_and_validate(payload):
    examples = payload.get("examples", [])
    min_confidence = float(payload.get("minConfidence", 0.70))
    min_margin = float(payload.get("minMargin", 0.15))

    # Agrupa por textHash único para evitar vazamento de duplicados entre treino e validação
    unique_by_hash = {}
    for ex in examples:
        h = ex["textHash"]
        if h not in unique_by_hash:
            unique_by_hash[h] = ex

    dedup_examples = list(unique_by_hash.values())
    texts = [ex["text"] for ex in dedup_examples]
    labels = [ex["categoryKey"] for ex in dedup_examples]
    display_map = {ex["categoryKey"]: ex["displayName"] for ex in examples}
    unique_labels = sorted(list(set(labels)))

    vectorizer = TfidfVectorizer(
        ngram_range=(1, 2),
        sublinear_tf=True,
        max_features=15000,
        lowercase=True,
        strip_accents=None,
        token_pattern=r"(?u)\b\w\w+\b"
    )

    X = vectorizer.fit_transform(texts)
    X_dense = normalize(X, norm="l2").toarray()
    vocab = vectorizer.vocabulary_
    idf = vectorizer.idf_.tolist()

    # Calcula centróides L2-normalizados por classe
    centroids = {}
    intra_sims = {}
    for lbl in unique_labels:
        idx = [i for i, y in enumerate(labels) if y == lbl]
        class_vecs = X_dense[idx]
        mean_vec = np.mean(class_vecs, axis=0)
        norm_val = np.linalg.norm(mean_vec)
        if norm_val > 1e-12:
            mean_vec = mean_vec / norm_val
        centroids[lbl] = mean_vec.tolist()
        sims = [compute_cosine_sim(v, mean_vec) for v in class_vecs]
        intra_sims[lbl] = float(np.mean(sims)) if sims else 0.0

    # Caso 1: Apenas 1 categoria elegível (>= 10 exemplos) -> Validação de coesão 5-fold
    if len(unique_labels) == 1:
        lbl = unique_labels[0]
        n_samples = len(texts)
        k_folds = min(5, n_samples)
        fold_size = max(1, n_samples // k_folds)
        held_out_Right = 0
        review_count = 0

        for f in range(k_folds):
            start = f * fold_size
            end = n_samples if f == k_folds - 1 else (f + 1) * fold_size
            val_idx = list(range(start, end))
            train_idx = [i for i in range(n_samples) if i not in val_idx]
            if not train_idx or not val_idx:
                continue
            train_centroid = np.mean(X_dense[train_idx], axis=0)
            norm_c = np.linalg.norm(train_centroid)
            if norm_c > 1e-12:
                train_centroid = train_centroid / norm_c
            for vi in val_idx:
                sim = compute_cosine_sim(X_dense[vi], train_centroid)
                # Calibração de confiança para classe única baseada em similaridade cosseno TF-IDF
                conf = min(0.99, max(0.0, (sim - 0.05) / 0.45))
                if conf >= min_confidence:
                    held_out_Right += 1
                else:
                    review_count += 1

        acc = held_out_Right / float(n_samples) if n_samples > 0 else 0.0
        f1_val = (2.0 * acc) / (1.0 + acc) if acc > 0 else 0.0
        review_rate = review_count / float(n_samples) if n_samples > 0 else 1.0

        inv_vocab = {int(v): k for k, v in vocab.items()}
        ordered_terms = [inv_vocab[i] for i in range(len(inv_vocab))]

        return {
            "report": {
                "accuracy": round(acc, 4),
                "macroF1": round(f1_val, 4),
                "manualReviewRate": round(review_rate, 4),
                "perCategory": {
                    lbl: {
                        "categoryKey": lbl,
                        "displayName": display_map[lbl],
                        "support": len(examples),
                        "precision": round(1.0 if held_out_Right > 0 else 0.0, 4),
                        "recall": round(acc, 4),
                        "f1Score": round(f1_val, 4),
                    }
                },
                "confusionMatrix": {
                    "labels": unique_labels,
                    "matrix": [[held_out_Right]],
                },
                "engine": "python_sklearn",
            },
            "artifact": {
                "engine": "python_sklearn",
                "labels": unique_labels,
                "displayMap": display_map,
                "terms": ordered_terms,
                "idf": idf,
                "centroids": centroids,
                "intraSims": intra_sims,
                "weights": None,
                "intercepts": None,
            },
        }

    # Caso 2: Multi-classe (>= 2 categorias elegíveis) -> Stratified K-Fold + LogisticRegression
    min_class_count = min(labels.count(lbl) for lbl in unique_labels)
    n_splits = min(5, max(2, min_class_count))
    skf = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)

    y_true_all = []
    y_pred_all = []
    review_count = 0

    for train_idx, val_idx in skf.split(X_dense, labels):
        X_tr = X_dense[train_idx]
        y_tr = [labels[i] for i in train_idx]
        X_va = X_dense[val_idx]
        y_va = [labels[i] for i in val_idx]

        clf_fold = LogisticRegression(
            class_weight="balanced", C=3.0, max_iter=500, random_state=42
        )
        clf_fold.fit(X_tr, y_tr)
        probs = clf_fold.predict_proba(X_va)
        fold_classes = list(clf_fold.classes_)

        # Centróides do fold
        fold_centroids = {}
        for c_lbl in fold_classes:
            c_indices = [i for i, y_val in enumerate(y_tr) if y_val == c_lbl]
            c_vec = np.mean(X_tr[c_indices], axis=0)
            c_norm = np.linalg.norm(c_vec)
            if c_norm > 1e-12:
                c_vec = c_vec / c_norm
            fold_centroids[c_lbl] = c_vec

        for row_i, p_vec in enumerate(probs):
            sorted_idx = np.argsort(p_vec)[::-1]
            best_i = sorted_idx[0]
            second_i = sorted_idx[1] if len(sorted_idx) > 1 else best_i
            best_lbl = fold_classes[best_i]
            p_best = float(p_vec[best_i])
            p_second = float(p_vec[second_i]) if len(sorted_idx) > 1 else 0.0

            sim_c = compute_cosine_sim(X_va[row_i], fold_centroids[best_lbl])
            calibrated_conf = 0.65 * p_best + 0.35 * min(1.0, sim_c / 0.35)
            margin = p_best - p_second

            if calibrated_conf < min_confidence or margin < min_margin or sim_c < 0.08:
                review_count += 1

            y_true_all.append(y_va[row_i])
            y_pred_all.append(best_lbl)

    acc = float(accuracy_score(y_true_all, y_pred_all))
    prec, rec, f1, _ = precision_recall_fscore_support(
        y_true_all, y_pred_all, labels=unique_labels, zero_division=0
    )
    cm = confusion_matrix(y_true_all, y_pred_all, labels=unique_labels).tolist()
    macro_f1 = float(np.mean(f1))
    review_rate = review_count / float(len(y_true_all)) if y_true_all else 0.0

    # Treina modelo final com todos os exemplos deduplicados
    final_clf = LogisticRegression(
        class_weight="balanced", C=3.0, max_iter=500, random_state=42
    )
    final_clf.fit(X_dense, labels)

    inv_vocab = {int(v): k for k, v in vocab.items()}
    ordered_terms = [inv_vocab[i] for i in range(len(inv_vocab))]

    # Em classificação binária, o scikit-learn retorna coef_ com shape (1, n_features)
    if len(unique_labels) == 2:
        w_pos = final_clf.coef_[0]
        b_pos = float(final_clf.intercept_[0])
        weights = [(-w_pos).tolist(), w_pos.tolist()]
        intercepts = [-b_pos, b_pos]
    else:
        weights = final_clf.coef_.tolist()
        intercepts = final_clf.intercept_.tolist()

    per_cat = {}
    for idx_l, lbl in enumerate(unique_labels):
        per_cat[lbl] = {
            "categoryKey": lbl,
            "displayName": display_map[lbl],
            "support": sum(1 for ex in examples if ex["categoryKey"] == lbl),
            "precision": round(float(prec[idx_l]), 4),
            "recall": round(float(rec[idx_l]), 4),
            "f1Score": round(float(f1[idx_l]), 4),
        }

    return {
        "report": {
            "accuracy": round(acc, 4),
            "macroF1": round(macro_f1, 4),
            "manualReviewRate": round(review_rate, 4),
            "perCategory": per_cat,
            "confusionMatrix": {
                "labels": unique_labels,
                "matrix": cm,
            },
            "engine": "python_sklearn",
        },
        "artifact": {
            "engine": "python_sklearn",
            "labels": list(final_clf.classes_),
            "displayMap": display_map,
            "terms": ordered_terms,
            "idf": idf,
            "centroids": centroids,
            "intraSims": intra_sims,
            "weights": weights,
            "intercepts": intercepts,
        },
    }


def main():
    raw_input = sys.stdin.read()
    if not raw_input.strip():
        sys.exit(1)
    payload = json.loads(raw_input)
    action = payload.get("action", "train")
    if action == "train":
        result = train_and_validate(payload)
        sys.stdout.write(json.dumps(result))
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
