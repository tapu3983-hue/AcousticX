# Acoustic Air-Gap FSK — implementation plan

## Product and implementation

A single responsive React/TypeScript screen demonstrates real browser-local FSK transmission from one device's speaker to another device's microphone. There is no application backend, network transport, pairing, or external dependency. The transmission is framed with an alternating preamble, a compact length field, a UTF-8 payload and CRC-8. Web Audio API synthesizes continuous-phase-enough, ramped binary FSK tones into a scheduled audio buffer. The receiver requests microphone access, computes short-window Goertzel tone energies at the configured frequencies, searches the preamble, samples symbols at the recovered timing, validates framing/CRC, and converts the payload back to text. Frequencies, sample-rate constraints, browser permissions, signal quality and timeouts are handled explicitly; high-frequency hardware support is not assumed.

The three-column visual tells the story at a glance: transmitter device, large moving acoustic air gap, receiver device. One dominant send control runs the explanatory stages while the real audio frame is emitted; receiver mode has an independent start-listening control so two physically separate browser instances can work together. The animated waveform and small spectrum are explanatory views driven by transmission/detection state; the microphone decoder uses actual sampled audio. Demo mode hides nonessential controls but preserves the main transfer story. Noise is an optional, clearly labeled transmitter-side simulation that mixes the opposite FSK tone into the emitted signal; it can weaken detection/cause CRC failure, is not a room-noise measurement, and is disabled on receiver mode.

## Project structure

- `client/src/pages/Home.tsx`: the complete single-screen interface, mode controls, demo flow, state/status and concise scientific note.
- `client/src/lib/fsk.ts`: independent frame encoding/CRC, Web Audio FSK generation, audio signal analysis and receive decoder helpers.
- `client/src/index.css`: cohesive dark responsive research-lab design, devices, acoustic wave animation, waveform/spectrum and reduced-motion behavior.
- `client/public/manus-routes.json`: route declaration for the sole `/` page, served before the Vite app starts.
- `app.config.ts`: project logo metadata for the saved site version.
- `TODO.md`: scoped outcomes and acceptance clauses from the request.

The existing React + TypeScript + Vite static starter and dependencies remain in place. No server, database, account, cloud audio processing or new package is required. The browser's secure-context microphone permission is the only receiver prerequisite; the sender can play locally generated audio.

## Design

**Design Movement:** Minimalist acoustic-instrumentation interface, using restrained research-lab details rather than a general dashboard.

**Core Principles:** The data path is instantly legible; real function takes priority over decoration; controls remain few and labeled in plain language; hardware limitations are stated honestly.

**Color Philosophy:** Deep blue-black surfaces give the lab a calm, focused backdrop. Warm-white text preserves clarity, while a restrained cyan signal color identifies sound and green indicates verified reception. Red is reserved for decode/CRC failure.

**Layout Paradigm:** A linear left-to-right instrument bench: distinct transmitter and receiver endpoints separated by generous air-gap space. On small screens the path stacks in the same reading order.

**Signature Elements:** A fine cyan acoustic trace crossing the central gap; compact device silhouettes with lit speaker/microphone indicators; tiny frequency labels and a two-peak spectrum.

**Interaction Philosophy:** One obvious SEND action for presenters; listening is separately armed on the receiver device; state and permissions are visible at the point of action. Demo mode reduces controls without concealing whether communication is actually active.

**Animation:** Short, smooth signal motion follows each bit's distinct frequency. Progress labels illuminate sequentially. Receiver peak tracks the detected tone. Success has one restrained wave pass; failure settles quietly into a clear status. Honor `prefers-reduced-motion`.

**Typography System:** Use a clean UI sans for primary labels, with tabular/monospaced figures for binary and frequency values. Strong uppercase section labels support quick scanning; the decoded message is largest on the receiver.

**Brand Essence:** A hands-on acoustic communications research demo that makes air-gap FSK understandable and testable; direct, precise, approachable.

**Brand Voice:** Short, matter-of-fact, demonstrative. Examples: “Data, carried by sound.” “Listening for the preamble.”

**Wordmark & Logo:** A compact speaker-wave-to-microphone glyph, paired with a small acoustic-link line; no decorative 3D or hacker motifs.

**Signature Brand Color:** Signal cyan, used sparingly for the travelling acoustic trace and active signal state.
