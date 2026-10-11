# Day 26 — Local LLMs under Ollama

Run 2026-10-11 12:56 UTC on Apple M2, 16 GB RAM, macOS 26.6.2; Ollama 0.40.2 at http://localhost:11434.
Temperature 0, seed 42, think false. Models ran one at a time: warm-up (not counted), 5 requests, unload.

## Summary

| model | quant | checks passed | load time | mean TTFT | mean generation | mean total latency |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `gemma4:12b` | 12.4B nvfp4 | 5/5 | 6.72 s | 1.72 s | 12.5 tok/s | 8.70 s |
| `qwen3.5:9b` | 9.7B nvfp4 | 5/5 | 5.93 s | 1.63 s | 13.8 tok/s | 8.32 s |

TTFT ≈ load_duration + prompt_eval_duration (Ollama's own timings, non-streaming). Generation = eval_count / eval_duration. Total = total_duration.

## Findings

- **gemma4:12b** passed all 5 checks.
- **qwen3.5:9b** passed all 5 checks.
- **Speed:** qwen3.5:9b generates 13.8 tok/s vs 12.5 tok/s for gemma4:12b (1.10×); mean latency 8.32 s vs 8.70 s.
- **Token-weighted rates** (all tokens / all time): generation gemma4:12b 14.8 vs qwen3.5:9b 17.2 tok/s; prompt processing gemma4:12b 60.9 vs qwen3.5:9b 95.0 tok/s.
- **Cold load** (warm-up, not counted): qwen3.5:9b 5.93 s, gemma4:12b 6.72 s.
- gemma4:12b's longest answer was `reasoning`: 399 tokens in 28.05 s (77% of all its generated tokens).
- qwen3.5:9b's longest answer was `reasoning`: 439 tokens in 26.00 s (77% of all its generated tokens).
- Prompt cache hits: gemma4:12b / `grounded-unanswerable` reused 254 of 281 prompt tokens (prompt eval 0.56 s, TTFT 0.57 s).

## Models

| model | family | parameters | quantization | format / runner | size | capabilities |
| --- | --- | --- | --- | --- | ---: | --- |
| `gemma4:12b` | gemma4_unified | 12.4B | nvfp4 | safetensors / mlx | 7.7 GB | completion, vision, audio, tools, thinking |
| `qwen3.5:9b` | qwen3_5 | 9.7B | nvfp4 | safetensors / mlx | 7.6 GB | completion, vision, tools, thinking |

## Requests

### `simple` — Short factual question

> What is the capital of Australia? Answer with the city name only.

Check: `contains`

| model | check | TTFT | prompt tok/s | gen tok/s | gen tokens | total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `gemma4:12b` | ✅ contains Canberra | 0.57 s | 42 | 6.9 | 2 | 0.87 s |
| `qwen3.5:9b` | ✅ contains Canberra | 0.39 s | 72 | 9.2 | 2 | 0.61 s |

**gemma4:12b:**

````text
Canberra
````

**qwen3.5:9b:**

````text
Canberra
````

### `reasoning` — Multi-step word problem

> A bakery bakes 240 cookies. In the morning it sells 3/8 of them. In the afternoon it sells 40% of the cookies that are left. In the evening it packs the remaining cookies into boxes of 12. How many boxes can it fill completely?
> 
> Work it out step by step, then finish with a last line of the form "Answer: <number>".

Check: `number`

| model | check | TTFT | prompt tok/s | gen tok/s | gen tokens | total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `gemma4:12b` | ✅ answer 7 | 1.55 s | 61 | 15.1 | 399 | 28.05 s |
| `qwen3.5:9b` | ✅ answer 7 | 1.02 s | 95 | 17.6 | 439 | 26.00 s |

**gemma4:12b:**

````text
To find the number of boxes the bakery can fill, we will calculate the number of cookies remaining after each period of the day.

**Step 1: Calculate the number of cookies sold in the morning.**
The bakery starts with 240 cookies.
The fraction sold in the morning is $\frac{3}{8}$.
$\text{Morning sales} = 240 \times \frac{3}{8}$
$240 \div 8 = 30$
$30 \times 3 = 90$ cookies.

**Step 2: Calculate the cookies remaining after the morning.**
$\text{Remaining} = 240 - 90 = 150$ cookies.

**Step 3: Calculate the number of cookies sold in the afternoon.**
The bakery sells 40% of the cookies that were left (150).
$\text{Afternoon sales} = 150 \times 0.40$
$150 \times 0.4 = 60$ cookies.

**Step 4: Calculate the cookies remaining after the afternoon.**
$\text{Remaining} = 150 - 60 = 90$ cookies.

**Step 5: Calculate the number of boxes filled in the evening.**
The remaining 90 cookies are packed into boxes of 12.
$\text{Number of boxes} = 90 \div 12$
$90 \div 12 = 7.5$

Since the question asks how many boxes it can fill **completely**, we take the whole number.
$12 \times 7 = 84$
$12 \times 8 = 96$
Therefore, 7 boxes can be filled completely, with 6 cookies left over.

Answer: 7
````

**qwen3.5:9b:**

````text
Here is the step-by-step solution:

**Step 1: Calculate the number of cookies sold in the morning.**
The bakery starts with 240 cookies. In the morning, it sells $\frac{3}{8}$ of them.
$$ \text{Morning Sales} = 240 \times \frac{3}{8} $$
$$ \text{Morning Sales} = \frac{720}{8} = 90 \text{ cookies} $$

**Step 2: Calculate the number of cookies remaining after the morning.**
Subtract the morning sales from the total.
$$ \text{Remaining (Morning)} = 240 - 90 = 150 \text{ cookies} $$

**Step 3: Calculate the number of cookies sold in the afternoon.**
In the afternoon, it sells 40% of the *remaining* cookies (which is 150).
$$ \text{Afternoon Sales} = 150 \times 40\% $$
$$ \text{Afternoon Sales} = 150 \times 0.40 = 60 \text{ cookies} $$

**Step 4: Calculate the number of cookies remaining after the afternoon.**
Subtract the afternoon sales from the morning remainder.
$$ \text{Remaining (Evening)} = 150 - 60 = 90 \text{ cookies} $$

**Step 5: Calculate the number of boxes filled in the evening.**
The remaining 90 cookies are packed into boxes of 12. We divide the total remaining cookies by the box size.
$$ \text{Number of Boxes} = \frac{90}{12} $$
$$ \text{Number of Boxes} = 7.5 $$

Since the question asks how many boxes can be filled **completely**, we must take only the whole number part (we cannot count a half-filled box as a completely filled one).
$$ \text{Complete Boxes} = 7 $$

Answer: 7
````

### `structured` — Extract fields into JSON (format = JSON schema)

> Extract the order from this message as JSON. Use ISO dates (YYYY-MM-DD) and an ISO currency code.
> 
> "Hi! This is Maria Lopez. On 14 March 2026 I placed order #A-1043 for three USB-C docks at €89.50 each. Please ship them to my office in Lisbon, and yes, I'd like express delivery."

Check: `json` · `format`: JSON schema

| model | check | TTFT | prompt tok/s | gen tok/s | gen tokens | total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `gemma4:12b` | ✅ valid JSON, schema ok, all values match | 1.52 s | 67 | 14.2 | 80 | 7.25 s |
| `qwen3.5:9b` | ✅ valid JSON, schema ok, all values match | 0.97 s | 98 | 16.5 | 98 | 6.91 s |

**gemma4:12b:**

````text
{"order_id": "A-1043", "customer": "Maria Lopez", "date": "2026-03-14", "product": "USB-C docks", "quantity": 3, "unit_price": 89.50, "currency": "EUR", "city": "Lisbon", "express": true}
````

**qwen3.5:9b:**

````text
{
  "order_id": "A-1043",
  "customer": "Maria Lopez",
  "date": "2026-03-14",
  "product": "USB-C dock",
  "quantity": 3,
  "unit_price": 89.50,
  "currency": "EUR",
  "city": "Lisbon",
  "express": true
}
````

### `grounded-answerable` — Grounded: the passage has the answer

Passage: `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:3` (Performance that’s ready for production)

> How much does Compose Multiplatform add to the size of an iOS app?

Check: `grounded`

| model | check | TTFT | prompt tok/s | gen tok/s | gen tokens | total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `gemma4:12b` | ✅ contains 9 mb \| 9mb \| 9 megabytes | 4.41 s | 63 | 15.8 | 30 | 6.31 s |
| `qwen3.5:9b` | ✅ contains 9 mb \| 9mb \| 9 megabytes | 2.86 s | 97 | 16.3 | 30 | 4.71 s |

**gemma4:12b:**

````text
Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets.
````

**qwen3.5:9b:**

````text
Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets.
````

### `grounded-unanswerable` — Grounded: the passage doesn't have the answer

Passage: `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:3` (Performance that’s ready for production)

> What is the minimum iOS version that Compose Multiplatform 1.8.0 supports?

Check: `grounded`

| model | check | TTFT | prompt tok/s | gen tok/s | gen tokens | total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `gemma4:12b` | ✅ declined | 0.57 s | 48 | 10.7 | 5 | 1.04 s |
| `qwen3.5:9b` | ✅ declined | 2.93 s | 95 | 9.5 | 4 | 3.35 s |

**gemma4:12b:**

````text
I don't know
````

**qwen3.5:9b:**

````text
I don't know
````
