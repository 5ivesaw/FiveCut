# OpenCut Linux desktop app

This is a small GTK/WebKit shell for the usable editor at
`https://opencut.app/projects`. It keeps browser data in a dedicated OpenCut
profile and saves exports to the user's Downloads directory.

The current repository is the from-scratch OpenCut rewrite; its own desktop
target is only an early UI shell and its web editor is marked "Coming soon."
The wrapper therefore opens the classic editor that the upstream README
currently recommends.

Runtime packages on Ubuntu/Pop!_OS:

```sh
sudo apt-get install --no-install-recommends \
  python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1
```

This checkout bundles only the three small WebKit metadata files needed on the
target Ubuntu/Pop!_OS machine. It reuses the WebKit and GTK libraries already
installed by the operating system, so installation does not require `sudo`.

Install it for the current user:

```sh
./packaging/linux/install.sh
```

Then launch it from the app menu by searching for **OpenCut**, or run:

```sh
opencut
```

The application interface is loaded from the official OpenCut site. Projects
and imported media remain in the app's local browser storage; an internet
connection is required to fetch uncached application files.

If the WebKit bindings are unavailable, the command falls back to opening the
editor in Firefox. Running `opencut --browser` explicitly uses Firefox.
