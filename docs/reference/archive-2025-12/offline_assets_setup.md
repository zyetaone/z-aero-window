---
description: How to find and set up offline 3D city models (GLB)
---

# Setting up Offline 3D Assets

Since Google 3D Tiles cannot be used offline, you can download free 3D models for your cities and load them locally.

## 1. Create Assets Directory

Ensure this folder exists:
`src/lib/assets/` (or `static/assets/` depending on your build setup - for this project, put them in **`static/assets/`**)

## 2. Download Models

Here are search links for free models. Look for **.glb** or **.gltf** formats. If you find .obj or .fbx, you'll need to convert them (e.g., using Blender).

### Dallas (DAL)

- **Target File**: `DAL.glb`
- [Search Sketchfab for Dallas](https://sketchfab.com/search?q=dallas+city&type=models&downloadable=true)

### Chicago (ORD)

- **Target File**: `ORD.glb`
- [Search Sketchfab for Chicago](https://sketchfab.com/search?q=chicago+city&type=models&downloadable=true)

### Phoenix (PHX)

- **Target File**: `PHX.glb`
- [Search Sketchfab for Phoenix](https://sketchfab.com/search?q=phoenix+city&type=models&downloadable=true)

### Las Vegas (LAS)

- **Target File**: `LAS.glb`
- [Search Sketchfab for Las Vegas](https://sketchfab.com/search?q=las+vegas+strip&type=models&downloadable=true)

### Denver (DEN)

- **Target File**: `DEN.glb`
- [Search Sketchfab for Denver](https://sketchfab.com/search?q=denver+city&type=models&downloadable=true)

### Hyderabad (HYD)

- **Target File**: `HYD.glb`
- [Search Sketchfab for Hyderabad](https://sketchfab.com/search?q=hyderabad+charminar&type=models&downloadable=true)

## 3. Install Models

1.  Rename your downloaded file to the city code (e.g., `DAL.glb`).
2.  Move it to `aero_dynamicWindow/static/assets/`.

## 4. Enable in App

1.  Run the app.
2.  Open **Debug Panel**.
3.  Toggle **Enable Local GLB**.
