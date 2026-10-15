# Memory Grid 🧠

A cozy two-player online memory game. Look at the grid, remember it, put everything back!

**Play:** https://naman9245.github.io/memory-grid-game/

## How to play

1. One player taps **Create Game** and shares the link (or the room code) with their partner.
2. Both tap **Ready**. A grid of pictures shows for a few seconds, then hides.
3. Put every picture back in its box before the timer runs out: tap a picture, then tap its box.
4. Every picture in the right box is 1 point; each wrong one costs that point (9 − 1 = 8).
5. Three rounds, each bigger than the last. Most points after round 3 wins.

| Round | Grid | Look | Put back | Max points |
|---|---|---|---|---|
| 1 | 3×3 | 10 sec | 30 sec | 9 |
| 2 | 4×4 | 15 sec | 45 sec | 16 |
| 3 | 5×5 | 20 sec | 60 sec | 25 |

Plain HTML, CSS and JavaScript. Live sync between the two phones uses Supabase Realtime
(project `grid-memory`). To try both seats on one computer, open a second tab with `?profile=b`.
