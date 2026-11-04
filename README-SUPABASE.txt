MonetaTribe - Supabase Edition

Files:
- index.html
- style.css
- script.js
- supabase-config.js

Important:
The HTML loads the Supabase JavaScript v2 library first, then the public project configuration, then script.js.
The browser uses only the Supabase Project URL and Publishable key. Never put a Secret/service_role key in browser code.

Family profiles:
Before using Create a Family or Join a Family, run `supabase-family-migration.sql` once in the Supabase Dashboard SQL Editor. It creates the family/membership tables, secure RPC functions, and shared-budget row access policies. Each account can belong to one family at a time. Family invite codes are six digits and remain with the family.

Run locally:
1. Extract the whole ZIP to a folder.
2. Open that folder in VS Code.
3. Start Live Server from index.html.
4. Log in using your confirmed Supabase email and password.

The Supabase JavaScript library is loaded from jsDelivr, so an internet connection is required.
