// A very messy functional code...
// P.S.A. - I am not a developer.

require('dotenv').config();
const cron = require("node-cron"), { promisify } = require("util"), sleep = promisify(setTimeout);

const { client_id, client_secret, api_key } = { client_id: process.env.client_id, client_secret: process.env.client_secret, api_key: process.env.api_key, };
const rateLimit = { tracksPerInterval: 40, intervalDuration: 4 * 60 * 1000, remainingTracks: 40, lastResetTime: new Date().getTime(), };
let started;

function scheduleTask() {
    cron.schedule("0 0 * * 3", async () => {
        console.log(`Scheduled task started at ${new Date().toLocaleString("en-gb")}`);
        await main();
        console.log(`Scheduled task finished at ${new Date().toLocaleString("en-gb")}`);
    });
}

async function main() {
    started = new Date();

    let accessToken = await getAccessToken();
    const playlistUrls = await getPlaylistUrls(), tracks = await getTracksFromPlaylists(playlistUrls, accessToken);
    const count = tracks.length, invalidTracks = [], noPreview = [];

    for (const track of tracks) {
        if (isNearHour()) {
            accessToken = await getAccessToken();
            console.clear();
        }

        const payload = createPayload(track);
        if (!payload) {
            console.log("Payload is null, skipping...");
            invalidTracks.push(new Date());
            continue;
        }

        try {
            if (!payload.previewLink) {
                noPreview.push(new Date());
                continue;
            }

            await sleep(5000);
            await addTrackToAPI(payload);
        } catch (error) {
            console.log(error);
            invalidTracks.push(new Date());
            continue;
        }
    }

    await handleRemoveDuplicates();

    async function handleRemoveDuplicates() {
        let dups = null;
        while (!dups) {
            try {
                dups = await removeDuplicates();
            } catch (error) {
                if (error.response && error.response.status === 403) {
                    console.log(`403 error in removeDuplicates. Waiting for 5 minutes and retrying...`);
                    await sleep(5 * 60 * 1000);
                } else {
                    console.error("Error in removeDuplicates:", error.message);
                    break;
                }
            }
        }

        await sendMessageToDiscord(count, dups ? dups.count : 0, invalidTracks, noPreview);
        console.log(`Finished at ${new Date().toLocaleString("en-gb")}`);
    }

    function isNearHour() {
        const now = new Date(), expirationTime = now.getTime() + 3600000;
        return expirationTime - now.getTime() < 600000;
    }

    async function getAccessToken() {
        const params = new URLSearchParams({ grant_type: "client_credentials", client_id, client_secret });
        const response = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params, });
        const data = await response.json();
        return data.access_token;
    }

    async function getPlaylistUrls() {
        try {
            const response = await fetch("https://raw.githubusercontent.com/danielytuk/rndTrack/main/sources.txt");
            const textContent = await response.text();
            const playlistUrls = textContent.match(/https:\/\/open\.spotify\.com\/playlist\/[a-zA-Z0-9]+/g);
            return playlistUrls;
        } catch (error) {
            console.error("Error fetching playlist URLs:", error.message);
            throw error;
        }
    }

    async function getTracksFromPlaylists(playlistUrls, accessToken) {
        const allTracks = [];
        for (const playlistUrl of playlistUrls) {
            const tracks = await getTracksFromPlaylist(playlistUrl, accessToken);
            allTracks.push(...tracks);
        }
        return allTracks;
    }

    async function getTracksFromPlaylist(playlistUrl, accessToken) {
        const playlistId = playlistUrl.split("/playlist/").pop();
        const apiUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks`;

        try {
            const response = await fetch(apiUrl, { headers: { Authorization: `Bearer ${accessToken}` }, });
            const data = await response.json();
            return data.items.map((item) => item.track);
        } catch (error) {
            console.error(`Error fetching tracks from playlist ${playlistUrl}:`, error.message);
            throw error;
        }
    }

    function createPayload(data) {
        try {
            if (!data) {
                console.log("Data is null, skipping...");
                return null;
            }

            const { id } = data;
            // const { artists, id, name, album, external_urls, preview_url, explicit } = data;
            // const artist = artists.map((a) => a.name).join(", ");
            // const releaseDate = album.release_date;
            // const albumArt = album.images[0].url;
            // const spotifyLink = external_urls.spotify;
            // const trackId = id;
            // const payload = { artist, track: name, album: album.name, trackId, releaseDate, albumArt, spotifyLink, previewLink: preview_url, explicit };
          
            const payload = { trackId }; // only save track id, fetch from Spotify API when required.
            return payload;
        } catch (error) {
            return null;
        }
    }

    async function addTrackToAPI(payload) {
        try {
            checkRateLimit();
            const response = await fetch(`${process.env.rndtrack}?api_key=${api_key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), });
            console.log(`[Added]: ${payload.artist} - ${payload.track}`);
        } catch (error) {
            if (error.response && error.response.status === 403) {
                console.log(`Rate limit reached. Starting rate limiting early.`);
                rateLimit.remainingTracks = 0;
                const sleepTime = rateLimit.lastResetTime + rateLimit.intervalDuration - new Date().getTime();
                console.log(`Sleeping for ${sleepTime / 1000} seconds.`);
                await sleep(sleepTime);
                rateLimit.lastResetTime = new Date().getTime();
            } else {
                console.log(`[Failed]: ${payload.artist} - ${payload.track}`);
            }
        }
    }

    function checkRateLimit() {
        const now = new Date().getTime();
        if (now - rateLimit.lastResetTime > rateLimit.intervalDuration) {
            rateLimit.lastResetTime = now;
            rateLimit.remainingTracks = rateLimit.tracksPerInterval;
        }

        if (rateLimit.remainingTracks <= 0) {
            const sleepTime = rateLimit.lastResetTime + rateLimit.intervalDuration - now;
            console.log(`Rate limit reached. Sleeping for ${sleepTime / 1000} seconds.`);
            sleep(sleepTime);
            rateLimit.lastResetTime = new Date().getTime();
            rateLimit.remainingTracks = rateLimit.tracksPerInterval;
        }

        rateLimit.remainingTracks--;
    }

    async function removeDuplicates() {
        const response = await fetch(`${process.env.removeDuplicates}?api_key=${api_key}`);
        const data = await response.json();
        return data;
    }

    async function sendMessageToDiscord(totalTracks, duplicates, invalidTracks, noPreview) {
        const subt = totalTracks - duplicates;
        const webhookUrl = process.env.discordNotification;
        try {
            await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    username: "rndTrack・Automation",
                    content: "<@517073424510746644>",
                    embeds: [
                        {
                            color: 16310587,
                            fields: [
                                { name: `Fetched ${totalTracks} tracks`, value: `** **` },
                                { name: `Added ${subt - invalidTracks.length} tracks`, value: `** **` },
                                { name: `Invalid ${invalidTracks.length}`, value: `** **` },
                                { name: `Removed ${duplicates}`, value: `** **` },
                                { name: `No Previews: ${noPreview.length} tracks`, value: `** **\nAdded by PSDM_VPS\nStarted: ${started.toLocaleString("en-gb")}\nFinished: ${new Date().toLocaleString("en-gb")}` },
                            ],
                        },
                    ],
                }),
            });
        } catch (error) {
            console.error("Error sending message to Discord:", error.message);
        }
    }
}

scheduleTask();
