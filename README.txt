MONETATRIBE PREMIUM - PASSWORD RECOVERY UPDATE

Files in this package:
- index.html
- style.css
- script.js
- monetatribe-logo.png

IMPORTANT: Keep your existing supabase-config.js file. It is not included in this package because it contains your project configuration.

INSTALLATION
1. Make a backup of your current MonetaTribe project folder.
2. Extract this package.
3. Copy index.html, style.css, script.js and monetatribe-logo.png into your existing project folder, replacing the old versions.
4. Do NOT replace or delete supabase-config.js.
5. Test locally, then push the updated files to GitHub Pages.

SUPABASE REDIRECT URL
In Supabase Dashboard, open Authentication > URL Configuration.
Ensure this URL is listed under Redirect URLs:
https://renjumathew7.github.io/MonetaTribe/

PASSWORD RESET FLOW
1. User selects Forgot Password? and submits their registered email.
2. Supabase emails a recovery link.
3. The recovery link opens MonetaTribe with a temporary recovery session.
4. The app detects Supabase's PASSWORD_RECOVERY event and displays the new-password form instead of the dashboard.
5. After the password is updated, the app signs out the recovery session and returns the user to login.

The Supabase publishable key remains in your existing supabase-config.js. Never put a service_role or secret key in browser code.
