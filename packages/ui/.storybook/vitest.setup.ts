// Tests check each story's settled state, so finish every animation and transition at once.
// Otherwise axe can measure contrast halfway through a fade-in, and the a11y checks turn flaky.
// Storybook's own UI and Chromatic still animate.
const instant = document.createElement("style");
instant.textContent = `*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
}`;
document.head.append(instant);
