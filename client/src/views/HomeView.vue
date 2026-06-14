<script setup lang="ts">
import { RouterLink } from 'vue-router';
</script>

<template>
  <section class="home">
    <h1>New deck</h1>
    <p class="muted">Pick a source. Both flows end in the same review and export.</p>

    <div class="home__cards">
      <RouterLink :to="{ name: 'upload' }" class="home__card">
        <div class="home__card__head">
          <span class="rule__bar"></span>
          <span class="rule__label">File</span>
        </div>
        <h2>Upload a video file</h2>
        <p>Drop a video + a matching .srt or .ass subtitle file you already have.</p>
      </RouterLink>

      <RouterLink :to="{ name: 'youtube' }" class="home__card">
        <div class="home__card__head">
          <span class="rule__bar"></span>
          <span class="rule__label">YouTube</span>
        </div>
        <h2>Paste a YouTube URL</h2>
        <p>
          We'll download the video, transcribe the Japanese audio with Whisper, and translate every
          sentence with whole-transcript context.
        </p>
      </RouterLink>
    </div>
  </section>
</template>

<style scoped>
.home {
  max-width: 880px;
}
h1 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 26px;
  margin: 0 0 8px;
}
.muted {
  color: var(--pageMuted);
  font-size: 14px;
  margin: 0 0 28px;
}
.home__cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.home__card {
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 8px;
  padding: 22px 24px;
  text-decoration: none;
  color: var(--pageInk);
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition:
    transform 120ms ease,
    border-color 120ms ease;
}
.home__card:hover {
  transform: translateY(-1px);
  border-color: var(--accent);
}
.home__card__head {
  display: flex;
  align-items: center;
  gap: 9px;
}
.rule__bar {
  width: 14px;
  height: 2px;
  background: var(--accent);
}
.rule__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
h2 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 18px;
  margin: 0;
}
p {
  color: var(--pageMuted);
  font-size: 13px;
  line-height: 1.55;
  margin: 0;
}
</style>
