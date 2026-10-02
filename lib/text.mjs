// Text normalising shared by the queue, company matching and the decoder. No imports, so any module can use it.

// Letters and digits of any script survive (Japanese, Greek, Hebrew ...), so non-Latin names never collapse to "".
// Accents are dropped from Latin letters only (é -> e); Cyrillic й and Japanese voiced kana keep their marks.
export const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/([a-z])\p{M}+/gu, '$1').normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
