---
description: How to set up a Google Maps API Key for 3D Tiles
---

# Setting up Google Maps 3D Tiles

Follow these steps to generate the required API key.

## 1. Create a Project

1.  Go to the [Google Cloud Console](https://console.cloud.google.com/).
2.  Click the project dropdown at the top and select **"New Project"**.
3.  Name it (e.g., "Flight Sim 3D") and click **Create**.

## 2. Enable the API

1.  In the left sidebar, go to **APIs & Services > Library**.
2.  Search for **"Map Tiles API"**.
    - _Note: Make sure it is "Map Tiles API", NOT "Maps JavaScript API"._
3.  Click on it and click **Enable**.

## 3. Set up Billing

1.  If prompted, you must enable billing.
2.  Google provides a **$200 monthly credit** which covers ~33,000 requests.
3.  For personal testing, you will likely never be charged, but a credit card is required for verification.

## 4. Create Credentials (API Key)

1.  Go to **APIs & Services > Credentials**.
2.  Click **+ CREATE CREDENTIALS** and select **API key**.
3.  Your new key will appear (starts with `AIza...`).
4.  **Copy this key**.

## 5. Use in App

1.  Go back to the Flight Simulator app.
2.  Open the **Debug Panel** (gear icon).
3.  Paste the key into the **API Key** field.
4.  Toggle **Enable 3D Tiles**.
