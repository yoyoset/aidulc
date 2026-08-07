import os
os.environ.setdefault("HF_HOME", r"F:\hf_cache")
import spacy
from collections import Counter

nlp = spacy.load("en_core_web_sm")
print("spacy loaded, pipe:", list(nlp.pipe_names))

# aidu 13 POS classes (from schema_constants.js) - verify against actual spaCy tags
AIDU_POS = ["adj", "adv", "conj", "det", "intj", "noun", "num", "prep", "pron", "propn", "punct", "verb", "x"]

samples = [
    "He broke the news to her carefully.",
    "The committee finally reached an agreement after hours of heated discussion.",
    "She told me to give up, but I decided to break the news anyway.",
    "They put off the meeting until next week, and everyone was relieved.",
    "The old man, who lived alone, finally decided to move on.",
]

for text in samples:
    doc = nlp(text)
    print(f"\n== {text}")
    for tok in doc:
        print(f"  {tok.text:<12} pos={tok.pos_:<8} tag={tok.tag_:<8} dep={tok.dep_:<8} lemma={tok.lemma_:<10}")

# phrasal verb candidates via dependency tree (prt/prep attached to verb)
print("\n== phrasal verb candidates ==")
for text in ["He broke up with her after the news.",
             "They put off the meeting until next week.",
             "She gave up smoking last year.",
             "The plane took off on time.",
             "I can't put up with this noise."]:
    doc = nlp(text)
    for tok in doc:
        if tok.dep_ == "prt":
            head = tok.head
            print(f"  prt: '{tok.text}' head='{head.text}' ({head.pos_}) -> candidate: {head.text} {tok.text}")
