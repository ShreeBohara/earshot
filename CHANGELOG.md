# Changelog

## [2.0.0-alpha.1](https://github.com/ShreeBohara/earshot/compare/v2.0.0-alpha.0...v2.0.0-alpha.1) (2026-11-15)


### Features

* add save_note tool and wire tool-call event logging ([dcc36a5](https://github.com/ShreeBohara/earshot/commit/dcc36a50b480b158f2a83368dcf081e5c1d2cb4f))
* AI Elements tool cards + English-lock system prompt ([d610d68](https://github.com/ShreeBohara/earshot/commit/d610d68f02750d6fc81f8d70c6df0968704e03ba))
* audible fallback chime when agent stays silent after tool ([e4daac3](https://github.com/ShreeBohara/earshot/commit/e4daac3fd882513637c4d361d6ebbdb257531f12))
* divergence chip + bi-directional customer correction (A3 complete) ([4568a29](https://github.com/ShreeBohara/earshot/commit/4568a298943bee46a1cfa738c7997da47a85def5))
* duplicate-task detection with confirmation flow ([62420f8](https://github.com/ShreeBohara/earshot/commit/62420f88ba21d8d95b629a50557760768caa5f13))
* editable transcript lines with undo (trust/correction UI, step 1) ([c810911](https://github.com/ShreeBohara/earshot/commit/c810911b9167c8335441a24cbf35260ba0ab1500))
* initial voice loop with OpenAI Realtime API over WebRTC ([55938b6](https://github.com/ShreeBohara/earshot/commit/55938b647669de8493dfc90f46ed85e830ecaa52))
* live transcript strip from history_updated events ([67292fd](https://github.com/ShreeBohara/earshot/commit/67292fd39d137c328cda408afea8619e36d5ad62))
* notes parity — update + delete tools with saved-notes panel ([7cb6853](https://github.com/ShreeBohara/earshot/commit/7cb685328f5e6320f4e23408de9dddc41bfa64b5))
* render agent tool calls as a UI action feed ([ccf71ed](https://github.com/ShreeBohara/earshot/commit/ccf71ed5c8193219374d8000feeb88375951322c))
* second tool create_follow_up_task with enum-typed channel ([e72203b](https://github.com/ShreeBohara/earshot/commit/e72203b47ee08c65ad48dd49a29ca52c6b7f1782))
* shadcn UI pass (Radix Nova style, forced dark mode) ([6a58e5e](https://github.com/ShreeBohara/earshot/commit/6a58e5e299e4102d19a59fe1fe73fd9fd8df14a5))
* update + cancel follow-up tools with active-tasks panel ([2c37e01](https://github.com/ShreeBohara/earshot/commit/2c37e01ae658523fc4c6e5ad0e33ffc0991e4683))
* v2 sprint — customer context, brief me, post-call summary, voice orb, polish ([9460aea](https://github.com/ShreeBohara/earshot/commit/9460aeafde0d13a2283dad4876cd3ce6c7b333da))
* v3 sprint — rep onboarding, call log, customer dossier, account/person hardening ([310a9ab](https://github.com/ShreeBohara/earshot/commit/310a9ab698a0be8e67ca8fd98c8caada209ba0b1))
* v3 sprint wrap — call controls, layout fit, pre-call coach, doc refresh ([1242623](https://github.com/ShreeBohara/earshot/commit/12426234352196a999e4c39cec4ae0e7ff6d3f41))
* web app on Workers via OpenNext, edge Worker with SessionDO, and Neon/Drizzle db ([#8](https://github.com/ShreeBohara/earshot/issues/8)) ([2b6b112](https://github.com/ShreeBohara/earshot/commit/2b6b1127ee4e444c59456a0297ab478e53d9f085))


### Bug Fixes

* add response.done as safety-net unmute (no-audio response case) ([b74aff1](https://github.com/ShreeBohara/earshot/commit/b74aff10b58536408ee76998e5ae1dcb5689445a))
* auto-mute mic while the agent is speaking ([720c172](https://github.com/ShreeBohara/earshot/commit/720c1728e640a80654c72fd951b513f70656f18a))
* auto-retry on gpt-realtime TPM rate-limit responses ([1cef204](https://github.com/ShreeBohara/earshot/commit/1cef204e7cd8e6e2c5aa3cc2b6c26c6486f20b10))
* center every Dialog at the primitive level (consent, onboarding, future) ([8243e97](https://github.com/ShreeBohara/earshot/commit/8243e9753eca6af0302dcd69441ea9cf325502c4))
* debounce auto-unmute to span tool turns' TWO response.created pairs ([e1a84d4](https://github.com/ShreeBohara/earshot/commit/e1a84d4596d1fdec07f492516161c4884fcfb226))
* reliability — relax VAD window + never-stay-silent prompt rule ([762963a](https://github.com/ShreeBohara/earshot/commit/762963aa31bcc8ee815864b2587d6bc30c61b8d0))
* reset amplitude on disconnect so the orb doesn't reuse the last call's value ([8dace8a](https://github.com/ShreeBohara/earshot/commit/8dace8a8a3adc3a88dfaca8f3583a6099ac9f0e3)), closes [#3](https://github.com/ShreeBohara/earshot/issues/3)
* semantic_vad eagerness high + VAD telemetry for silence debugging ([caae40d](https://github.com/ShreeBohara/earshot/commit/caae40dfde4e91bba50d64e4ca85c6305bf5a0c9))
* semantic_vad eagerness low — stop dropping back-to-back tool confirmations ([bfbbfe6](https://github.com/ShreeBohara/earshot/commit/bfbbfe67109e8ab0764ced2321d0d356b6a19a42))
* simplify auto-mute — response.created to mute, audio_stopped to unmute ([53b99f4](https://github.com/ShreeBohara/earshot/commit/53b99f44b5186691d83a1251645d7881631c74e7))
* switch from server_vad to semantic_vad for turn detection ([46230d4](https://github.com/ShreeBohara/earshot/commit/46230d49fd5d49b20588d861e1174e634f119214))
* synchronous auto-mute via refs + response.created for max lead time ([4a5da91](https://github.com/ShreeBohara/earshot/commit/4a5da91d2b47d844467f04830194f959ebe08762))
