import './styles.css'

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) throw new Error('App root not found')

app.innerHTML = `
  <main class="shell">
    <div class="pulse-line" aria-hidden="true"></div>
    <section class="hero">
      <div class="eyebrow">SCIENCE BY HUGs</div>
      <h1>PULSE</h1>
      <p class="tagline">Track. Measure. Evolve.</p>
      <p class="copy">A living dashboard for routines, schedules, progress, reminders, and personal tracking.</p>
    </section>
    <section class="grid">
      <article><span class="dot cyan"></span><h2>Track</h2><p>Build and follow schedules with clarity.</p></article>
      <article><span class="dot teal"></span><h2>Measure</h2><p>See trends, streaks, and logged history.</p></article>
      <article><span class="dot violet"></span><h2>Evolve</h2><p>Turn routine data into useful insight.</p></article>
    </section>
  </main>`
