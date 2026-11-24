[README.md](https://github.com/user-attachments/files/35313738/README.md)
# Vira Earth Dashboard v6.0

Lab Grown Diamonds Jewellery – shop dashboard (quotations, orders, estimates, inventory, customers, staff) that saves everything in Airtable.

- `index.html` – the dashboard
- `netlify/functions/vira.js` – secure connector between the dashboard and Airtable (the Airtable token lives only in Netlify)
- `netlify/functions/schema.json` – the 16 Airtable tables that "First-time setup" creates
- `images/` – product photos from the earlier version (kept for reference)

## Netlify environment variables
- `AIRTABLE_TOKEN` – personal access token with data.records:read, data.records:write, schema.bases:read, schema.bases:write, limited to the Vira Earth base
- `AIRTABLE_BASE_ID` – starts with `app`
- `APP_SECRET` – any long random text; also the key for "First-time setup" on the sign-in screen

Never commit the token to this repository.

The previous price dashboard is is in the git history at commit `52e1767` (revert to it any time).
