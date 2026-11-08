---
name: places-tracker
description: Log visited countries, US states, National Parks, UNESCO World Heritage Sites, World Wonders, and cities; compute "Places Been" completion statistics; recommend unvisited sights; and render interactive HTML Scratch & Flag Maps.
---

# PlacesTracker ("Places Been" AI Skill)

Use this skill whenever the user wants to:
- Log trips, visited places, bucket-list destinations, or favorite spots.
- Check their travel completion statistics (Countries, Continents, Flag Belt, 50 US States, 63 US National Parks, New 7 Wonders of the World, UNESCO World Heritage Sites, or Cities).
- Discover unvisited UNESCO sites, National Parks, or Wonders in a destination they are planning to visit.
- View an interactive **Scratch Map, Flag Map, & US States Cartogram** in the side pane.

## 1. Using MCP Tools (or CLI Fallback)

When the `places-tracker-mcp` server is active, call its tools directly:
- `places_mark`: Mark a list of places as `visited`, `bucket_list`, or `unvisited`. Parent countries and US states are automatically marked `visited` when a child city, national park, wonder, or UNESCO site is visited!
- `places_stats`: Fetch the user's complete travel statistics and flag belt.
- `places_search`: Search catalog places by keyword, category (`country`, `us_state`, `world_wonder`, `national_park`, `unesco`, `city`), status, country code, or continent.
- `places_recommend`: Find unvisited UNESCO sites, National Parks, Wonders, and cities for a target country, state, or continent.
- `places_add_custom`: Add a new custom place to the catalog and log it.
- `places_render_dashboard`: Generate the self-contained interactive HTML Scratch & Flag Map dashboard.

If the MCP server is not yet loaded in the current turn, run `python3 src/cli.py` with subcommands `stats`, `mark`, `search`, `recommend`, or `render`.

## 2. Rendering Interactive Visual Maps in Antigravity

Whenever the user asks to see their map, dashboard, or visual progress:
1. Generate the HTML using `places_render_dashboard` (or `cli.py render --output <artifact_dir>/places_dashboard.html`).
2. Save or copy the HTML to the conversation's artifact directory with `UserFacing: true` in `ArtifactMetadata` so the user can interact with the **World Flag & Scratch Map**, **50 US States Scratch Grid**, and **Category Explorer** right in the side pane!

