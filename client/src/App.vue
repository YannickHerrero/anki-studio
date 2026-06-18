<script setup lang="ts">
import { RouterView, RouterLink } from 'vue-router';
</script>

<template>
  <header class="app-header">
    <RouterLink to="/" class="brand">Anki Studio</RouterLink>
    <nav>
      <RouterLink to="/">Home</RouterLink>
      <RouterLink to="/upload">Upload</RouterLink>
      <RouterLink to="/youtube">YouTube</RouterLink>
      <RouterLink to="/sessions">Sessions</RouterLink>
      <RouterLink to="/known">Known words</RouterLink>
      <RouterLink to="/settings">Settings</RouterLink>
    </nav>
  </header>
  <main class="app-main">
    <RouterView />
  </main>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 28px;
  border-bottom: 1px solid var(--pageLine);
}
.brand {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 18px;
  color: var(--pageInk);
  text-decoration: none;
}
nav {
  display: flex;
  gap: 18px;
}
nav a {
  font-size: 13px;
  color: var(--pageMuted);
  text-decoration: none;
}
nav a.router-link-active {
  color: var(--pageInk);
}
.app-main {
  max-width: 980px;
  margin: 0 auto;
  padding: 32px 28px;
}
</style>
