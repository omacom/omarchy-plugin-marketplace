import {
  setupCopyButtons,
  setupSectionNavigation,
  setupThemeToggle,
} from "./shared.js?v=20260906-01";

setupThemeToggle();
setupCopyButtons();

setupSectionNavigation({
  sectionSelector: "#overview, .docs-section",
  linkSelector: ".right-aside .aside-link[href^='#'], .mobile-bottom a[href^='#']",
  markerRatio: 0.25,
  markerMax: 160,
  activateLastAtPageEnd: true,
});
