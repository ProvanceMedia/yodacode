# Google Chat

A two-way Google Chat bot. The easy path is the wizard — it does everything below for you:

```
yodacode googlechat
```

Google puts every chat bot behind a Cloud project + a service account (there's no "paste a
token" like Slack, and every framework hits the same wall). But unlike an HTTP-webhook bot,
YodaCode uses **Pub/Sub pull**, so there's **no public endpoint and no tunnel** — the bot
dials out, like Slack Socket Mode.

**You need:** a **Google Workspace** account (Chat apps don't work on personal Gmail) and a
**Google Cloud project**.

---

## Doing it by hand

### 1. Create the Google resources
Open **Cloud Shell** (already signed in, nothing to install):
<https://console.cloud.google.com/?cloudshell=true> — then run (swap in your `PROJECT` id):

```bash
gcloud config set project PROJECT
gcloud services enable chat.googleapis.com pubsub.googleapis.com
gcloud iam service-accounts create yodacode-chat --display-name "YodaCode Chat"
SA="yodacode-chat@PROJECT.iam.gserviceaccount.com"
gcloud pubsub topics create yodacode-chat
gcloud pubsub topics add-iam-policy-binding yodacode-chat \
  --member="serviceAccount:chat-api-push@system.gserviceaccount.com" --role="roles/pubsub.publisher"
gcloud pubsub subscriptions create yodacode-chat-sub --topic=yodacode-chat
gcloud pubsub subscriptions add-iam-policy-binding yodacode-chat-sub \
  --member="serviceAccount:$SA" --role="roles/pubsub.subscriber"
gcloud iam service-accounts keys create key.json --iam-account "$SA"
base64 -w0 key.json      # copy this one line
```

(`chat-api-push@system.gserviceaccount.com` is Google's own account that publishes Chat
events into your topic — granting it Publisher is what makes events flow to you.)

### 2. Turn the bot on
Open the Chat API configuration:
<https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat>

- App name, avatar URL, description.
- **Interactive features** ON; tick **Receive 1:1 messages** and **Join spaces**.
- **Connection settings → Cloud Pub/Sub**, topic `projects/PROJECT/topics/yodacode-chat`.
- **Visibility** → your email (or your whole domain). This is what gates who can reach it.
- **Save.**

### 3. Configure YodaCode
In `.env`:

```bash
YODA_SURFACES=slack,googlechat      # add googlechat to whatever you already run
GOOGLE_CHAT_SUBSCRIPTION=projects/PROJECT/subscriptions/yodacode-chat-sub
GOOGLE_CHAT_SA_KEY=<the base64 line from step 1>
YODA_GCHAT_DM_OPEN=1                 # the app's Visibility already gates who can reach it
```

Then `yodacode restart`, and DM the bot.

---

## Locking it down / spaces
- `YODA_GCHAT_DM_OPEN=1` lets anyone the app is visible to DM it. To restrict to specific
  people instead, drop it and set `YODA_GCHAT_AUTHORIZED=users/1234567890` (their Google
  user id).
- To answer **@mentions in a space**, set `YODA_GCHAT_SPACES=spaces/AAAA`.

## If it doesn't reply
Run `yodacode logs` — the pull loop prints any auth/subscription error. Usual causes: the
Chat app isn't visible to you yet, the subscription name is wrong, or the project has no
billing account linked (Pub/Sub needs one; the actual usage is well within the free tier).
