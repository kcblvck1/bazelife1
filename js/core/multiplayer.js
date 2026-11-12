import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

let client = null;
let communityChannel = null;
const configured = /^https:\/\/.+\.supabase\.co$/.test(SUPABASE_URL) &&
  SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes("YOUR_");

export async function initMultiplayer() {
  if (!configured) return { enabled: false, reason: "Supabase project keys have not been added." };
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return { enabled: true };
  } catch (error) {
    console.error("Supabase initialization failed", error);
    return { enabled: false, reason: "Could not load Supabase. Check your internet connection and project keys." };
  }
}

export function multiplayerEnabled() { return Boolean(client); }

export async function registerOnlineStudent({ email, password, name, username, gender }) {
  if (!client) throw new Error("Online multiplayer is not configured yet.");
  const { data, error } = await client.auth.signUp({
    email, password,
    options: { data: { name, username, gender } }
  });
  if (error) throw error;
  if (data.user && data.session) {
    const { error: profileError } = await client.from("profiles").upsert({
      id: data.user.id, username, display_name: name, gender,
      location: gender === "female" ? "Female Hostel" : "Male Hostel",
      last_seen: new Date().toISOString()
    });
    if (profileError) throw profileError;
  }
  return data;
}

export async function loginOnlineStudent(email, password) {
  if (!client) throw new Error("Online multiplayer is not configured yet.");
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const meta = data.user.user_metadata || {};
  const { data: profile, error: profileError } = await client.from("profiles")
    .select("username,display_name,gender,location")
    .eq("id", data.user.id).maybeSingle();
  if (profileError) throw profileError;
  return {
    id: data.user.id,
    name: profile?.display_name || meta.name || "Student",
    username: profile?.username || meta.username || data.user.email.split("@")[0],
    gender: profile?.gender || meta.gender || "male",
    email: data.user.email
  };
}

export async function logoutOnlineStudent() {
  if (client) await client.auth.signOut();
  if (communityChannel) { await client.removeChannel(communityChannel); communityChannel = null; }
}

export async function publishPlayerPresence(profile, location) {
  if (!client || !profile?.id) return;
  const channel = client.channel("baze-life-campus", { config: { presence: { key: profile.id } } });
  await new Promise(resolve => channel.subscribe(async status => {
    if (status === "SUBSCRIBED") {
      await channel.track({ user_id: profile.id, username: profile.username,
        display_name: profile.name, gender: profile.gender, location,
        online_at: new Date().toISOString() });
      resolve();
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") resolve();
  }));
  return channel;
}

export async function updateOnlineLocation(profile, location) {
  if (!client || !profile?.id) return;
  const seenAt = new Date().toISOString();
  const { error } = await client.from("profiles").update({ location, last_seen: seenAt }).eq("id", profile.id);
  if (error) throw error;
  if (communityChannel) await communityChannel.track({ user_id: profile.id, username: profile.username,
    display_name: profile.name, gender: profile.gender, location, online_at: seenAt });
}

export async function listOnlineProfiles(currentUserId) {
  if (!client) return [];
  const { data, error } = await client.from("profiles")
    .select("id,username,display_name,gender,location,last_seen")
    .neq("id", currentUserId).order("display_name");
  if (error) throw error;
  return data || [];
}

export async function loadRecentMessages(limit = 40) {
  if (!client) return [];
  const { data, error } = await client.from("messages")
    .select("id,sender_id,sender_username,body,created_at")
    .order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).reverse();
}

export async function sendCampusMessage(profile, body) {
  if (!client || !profile?.id) throw new Error("Log in online to chat with other students.");
  const clean = String(body || "").trim().slice(0, 500);
  if (!clean) return;
  const { error } = await client.from("messages").insert({
    sender_id: profile.id, sender_username: profile.username, body: clean
  });
  if (error) throw error;
}

export async function subscribeToCampus(profile, location, onPresence, onMessage) {
  if (!client) return null;
  if (communityChannel) await client.removeChannel(communityChannel);
  communityChannel = client.channel("baze-life-campus", { config: { presence: { key: "community" } } });
  communityChannel
    .on("presence", { event: "sync" }, () => onPresence(communityChannel.presenceState()))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, payload => onMessage(payload.new));
  await new Promise(resolve => communityChannel.subscribe(async status => {
    if (status === "SUBSCRIBED") {
      if (profile?.id) await communityChannel.track({ user_id: profile.id, username: profile.username, display_name: profile.name, gender: profile.gender, location, online_at: new Date().toISOString() });
      resolve();
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") resolve();
  }));
  return communityChannel;
}
