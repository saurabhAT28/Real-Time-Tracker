const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
// Only the public folder is exposed, not your whole project
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.render("index"));

// ---- State -----------------------------------------------------------
// rooms[roomId][userId] = { userId, name, latitude, longitude, accuracy, updatedAt }
const rooms = {};
// socket.id -> { room, userId }
const sessions = new Map();

const MIN_INTERVAL_MS = 1000; // server-side rate limit per socket
const lastSeen = new Map();   // socket.id -> timestamp of last accepted update

// ---- Helpers ---------------------------------------------------------
const cleanString = (value, max) =>
    String(value ?? "").replace(/[^\w\- ]/g, "").trim().slice(0, max);

const isValidCoords = (lat, lng) =>
    typeof lat === "number" && typeof lng === "number" &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

// ---- Socket handlers -------------------------------------------------
io.on("connection", (socket) => {
    console.log("Connected:", socket.id);

    socket.on("join", (payload = {}) => {
        const room = cleanString(payload.room, 40);
        const userId = cleanString(payload.userId, 40);
        const name = cleanString(payload.name, 24) || "Anonymous";

        if (!room || !userId) return;

        // Leave a previous room if the client re-joins
        const previous = sessions.get(socket.id);
        if (previous) socket.leave(previous.room);

        socket.join(room);
        sessions.set(socket.id, { room, userId, name });
        rooms[room] = rooms[room] || {};

        // Send everyone currently in the room to the newcomer
        socket.emit("initial-locations", Object.values(rooms[room]));
    });

    socket.on("send-location", (data = {}) => {
        const session = sessions.get(socket.id);
        if (!session) return; // must join first

        const now = Date.now();
        if (now - (lastSeen.get(socket.id) || 0) < MIN_INTERVAL_MS) return;
        lastSeen.set(socket.id, now);

        const { latitude, longitude } = data;
        if (!isValidCoords(latitude, longitude)) return;

        const accuracy = Number.isFinite(data.accuracy)
            ? Math.min(Math.max(data.accuracy, 0), 100000)
            : null;

        const user = {
            userId: session.userId,
            name: session.name,
            latitude,
            longitude,
            accuracy,
            updatedAt: now
        };

        rooms[session.room][session.userId] = user;
        // Only people in the same room receive this
        io.to(session.room).emit("receive-location", user);
    });

    socket.on("disconnect", () => {
        const session = sessions.get(socket.id);
        sessions.delete(socket.id);
        lastSeen.delete(socket.id);
        if (!session) return;

        const { room, userId } = session;

        // Only remove the user if no other tab/socket of theirs is still in the room
        const stillConnected = [...sessions.values()].some(
            (s) => s.room === room && s.userId === userId
        );
        if (stillConnected) return;

        if (rooms[room]) {
            delete rooms[room][userId];
            if (Object.keys(rooms[room]).length === 0) delete rooms[room];
        }
        io.to(room).emit("user-disconnected", userId);
        console.log("Disconnected:", socket.id);
    });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));