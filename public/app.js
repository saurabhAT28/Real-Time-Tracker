(function () {
    // ---- Identity & room -------------------------------------------------
    const randomId = () => Math.random().toString(36).slice(2, 10);

    // Persistent ID: the same person keeps the same marker after a reconnect/refresh
    let userId = localStorage.getItem("trackerUserId");
    if (!userId) {
        userId = randomId();
        localStorage.setItem("trackerUserId", userId);
    }

    let name = localStorage.getItem("trackerName");
    if (!name) {
        name = (prompt("Your name?") || "").trim().slice(0, 24) || "User-" + userId.slice(0, 4);
        localStorage.setItem("trackerName", name);
    }

    // Room comes from the URL (?room=abc). Create a random one if missing.
    const params = new URLSearchParams(location.search);
    let room = params.get("room");
    if (!room) {
        room = randomId();
        params.set("room", room);
        history.replaceState(null, "", "?" + params.toString());
    }

    // ---- Map ---------------------------------------------------------------
    const map = L.map("map").setView([20.5937, 78.9629], 5); // India overview until first fix

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    // ---- State -------------------------------------------------------------
    const users = {}; // userId -> { marker, circle, path, name, color }
    const MAX_PATH_POINTS = 300;
    let following = true;
    let firstOwnFix = true;

    const statusEl = document.getElementById("status");
    const usersEl = document.getElementById("users");
    const followBtn = document.getElementById("follow-btn");

    const setStatus = (text, cls) => {
        statusEl.textContent = text;
        statusEl.className = cls || "";
    };

    // Stable colour per user, derived from their id
    const colorFor = (id) => {
        let hash = 0;
        for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        return `hsl(${hash % 360}, 70%, 45%)`;
    };

    const makeIcon = (color) =>
        L.divIcon({
            className: "",
            html: `<div class="pin" style="background:${color}"></div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8]
        });

    const makeLabel = (text) => {
        const el = document.createElement("span");
        el.className = "name-tag";
        el.textContent = text; // textContent, so names can't inject HTML
        return el;
    };

    // ---- Marker management ----------------------------------------------------
    function upsertUser(data) {
        const { userId: id, latitude, longitude, accuracy } = data;
        const isMe = id === userId;
        const latlng = [latitude, longitude];
        const label = isMe ? `${data.name} (you)` : data.name;

        let u = users[id];
        if (!u) {
            const color = colorFor(id);
            u = users[id] = {
                color,
                name: label,
                marker: L.marker(latlng, { icon: makeIcon(color) })
                    .bindTooltip(makeLabel(label), { permanent: true, direction: "top", offset: [0, -8] })
                    .addTo(map),
                circle: L.circle(latlng, { radius: accuracy || 0, color, weight: 1, fillOpacity: 0.1 }).addTo(map),
                path: L.polyline([latlng], { color, weight: 3, opacity: 0.7 }).addTo(map)
            };
        } else {
            u.marker.setLatLng(latlng);
            u.circle.setLatLng(latlng).setRadius(accuracy || 0);

            const points = u.path.getLatLngs();
            points.push(L.latLng(latlng));
            if (points.length > MAX_PATH_POINTS) points.shift();
            u.path.setLatLngs(points);
        }

        renderUserList();

        if (isMe && following) {
            if (firstOwnFix) {
                map.setView(latlng, 16);
                firstOwnFix = false;
            } else {
                map.panTo(latlng);
            }
        }
    }

    function removeUser(id) {
        const u = users[id];
        if (!u) return;
        map.removeLayer(u.marker);
        map.removeLayer(u.circle);
        map.removeLayer(u.path);
        delete users[id];
        renderUserList();
    }

    function clearAllUsers() {
        Object.keys(users).forEach(removeUser);
    }

    function renderUserList() {
        usersEl.innerHTML = "";
        Object.entries(users).forEach(([id, u]) => {
            const row = document.createElement("div");
            row.className = "user-row";

            const dot = document.createElement("span");
            dot.className = "dot";
            dot.style.background = u.color;

            const text = document.createElement("span");
            text.textContent = u.name;

            row.append(dot, text);
            row.addEventListener("click", () => {
                following = false;
                followBtn.classList.remove("active");
                map.setView(u.marker.getLatLng(), 17);
            });
            usersEl.appendChild(row);
        });
    }

    function fitAll() {
        const layers = Object.values(users).map((u) => u.marker.getLatLng());
        if (layers.length === 0) return;
        if (layers.length === 1) return map.setView(layers[0], 16);
        map.fitBounds(L.latLngBounds(layers), { padding: [60, 60] });
    }

    // ---- Controls ------------------------------------------------------------
    followBtn.addEventListener("click", () => {
        following = !following;
        followBtn.classList.toggle("active", following);
        if (following && users[userId]) map.setView(users[userId].marker.getLatLng(), 16);
    });

    document.getElementById("fit-btn").addEventListener("click", () => {
        following = false;
        followBtn.classList.remove("active");
        fitAll();
    });

    document.getElementById("share-btn").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        try {
            await navigator.clipboard.writeText(location.href);
            btn.textContent = "Copied!";
        } catch {
            prompt("Copy this link:", location.href);
        }
        setTimeout(() => (btn.textContent = "Copy link"), 1500);
    });

    // Stop following if the user drags the map themselves
    map.on("dragstart", () => {
        following = false;
        followBtn.classList.remove("active");
    });

    // ---- Socket ---------------------------------------------------------------
    const socket = io();

    socket.on("connect", () => {
        setStatus("Connected", "ok");
        // (Re)join on every connect, including automatic reconnects
        socket.emit("join", { room, userId, name });
    });

    socket.on("disconnect", () => setStatus("Disconnected. Reconnecting…", "error"));

    socket.on("initial-locations", (all) => {
        clearAllUsers(); // avoids duplicates after a reconnect
        all.forEach(upsertUser);
    });

    socket.on("receive-location", upsertUser);
    socket.on("user-disconnected", removeUser);

    // ---- Geolocation ---------------------------------------------------------
    let lastSent = 0;
    const SEND_INTERVAL_MS = 3000;

    if (!navigator.geolocation) {
        setStatus("Geolocation not supported", "error");
    } else {
        navigator.geolocation.watchPosition(
            ({ coords }) => {
                const now = Date.now();
                if (now - lastSent < SEND_INTERVAL_MS) return; // throttle
                lastSent = now;

                socket.emit("send-location", {
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    accuracy: coords.accuracy
                });
            },
            (error) => {
                const messages = {
                    1: "Location permission denied",
                    2: "Location unavailable",
                    3: "Location request timed out"
                };
                setStatus(messages[error.code] || "Location error", "error");
                console.log(error);
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    }
})();