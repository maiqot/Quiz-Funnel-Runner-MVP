export const FUNNEL_URLS: string[] = [
  "https://coursiv.io/dynamic?prc_id=1069",
  "https://coursiv.io/dynamic",
  "https://quiz.fitme.expert/intro-111",
  "https://madmuscles.com/funnel/default-uni-soft-new/step-one",
  "https://dance-bit.com/welcomeBellyRef",
]; // Можно добавить сразу несколько ссылок для тестирования в кавычках через запятую

export const RUN_CONFIG = {
  maxSteps: 60,
  sameDomHashLimit: 12,
  actionRetryCount: 1,
  defaultTimeoutMs: 20_000,
} as const;

export const INPUT_DEFAULTS = {
  name: "John",
  height: "170",
  weight: "65",
  age: "30",
  email: "test@example.com",
} as const;
