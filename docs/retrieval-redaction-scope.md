# Retrieval output redaction scope

This candidate redacts values only when they are paired with a recognized explicit secret label, or stored under an explicitly named secret field. It does not detect unlabeled secrets, classify PHI, or provide general data-loss prevention.

The candidate covers ordinary Brain search, memory recall, open KB search, and the deep retrieval output boundary. Deep retrieval also sanitizes retrieved passages before content screening and synthesis, then sanitizes the synthesized answer and returned hits.

Privileged KB search is explicitly excluded from this candidate. `src/tools/kb/search-privileged.ts` is unchanged and has no redaction coverage here. Do not treat this candidate as protection for privileged retrieval.
