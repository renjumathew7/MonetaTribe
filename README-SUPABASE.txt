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
Before using Create a Family or Join a Family, run `supabase-family-migration.sql` once in the Supabase Dashboard SQL Editor. It creates the family/membership tables, secure RPC functions, and shared-budget row access policies. Run `supabase-family-members-migration.sql` as well to enable the Profile member list, Admin restrictions, and Exit Family. Run `supabase-delete-family-migration.sql` to install the Admin-only Delete Family action. These migrations define database behavior; they do not delete budget rows when run. Family members have full access until the Admin restricts them; restricted members can view budgets and add expense transactions only. Confirming Delete Family in the app permanently removes that family's shared budgets, pockets, and transactions; personal budgets remain. Each account can belong to one family at a time. Family invite codes are six digits and remain with the family unless the family is deleted.

Run locally:
1. Extract the whole ZIP to a folder.
2. Open that folder in VS Code.
3. Start Live Server from index.html.
4. Log in using your confirmed Supabase email and password.

The Supabase JavaScript library is loaded from jsDelivr, so an internet connection is required.
