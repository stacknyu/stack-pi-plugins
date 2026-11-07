# Glitchy example app

A small React 19 app with three planted glitches, for checking that Glitch Lab works on your machine:

1. **Sidebar rebuilt on every navigation.** Each page renders its own `<Sidebar>`, which refetches the user and flashes a skeleton.
2. **Chat box rebuilt every 1.5 s.** `ChatBox` is defined inside `ChatPage`, and a poll clears the messages before refetching them.
3. **Header credits flash "…".** They're reset on every route change.

```bash
node examples/glitchy-app/serve.mjs          # http://localhost:4321/dashboard
```

Then ask Pi: "glitch hunt http://localhost:4321/dashboard", and "idle watch http://localhost:4321/chat".
You should get all three as HIGH findings. Source is in `app.jsx`; the prebuilt bundle is in `public/app.js`.
