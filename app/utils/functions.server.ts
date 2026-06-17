import * as crypto from "crypto";
import jwt from "jsonwebtoken";
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

export const convertMongoTimestamp = (timestamp: any) => {
    return timestamp;
};

export const toBSON = (val: any) => val;
export const parseEJSON = JSON.parse;

export const parseObjectId = function (string) {
    return string;
};

// Convert docs to string
export const bsonToString = function (doc) {
    return JSON.stringify(doc);
};

export const toJsonString = function (doc) {
    return JSON.stringify(doc);
};

export const addHyphensToUUID = function (hex) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

function uuid4ToString(input) {
    const hex = input.toString("hex"); // same of input.buffer.toString('hex')
    return addHyphensToUUID(hex);
}

export const stringDocIDs = function (input) {
    return input;
};

export const generateGravatarUrl = (
    email,
    options: {
        size?: number;
        default?: string;
    } = {}
) => {
    // Normalize email
    const normalizedEmail = email.trim().toLowerCase();

    // Create MD5 hash
    const emailHash = crypto.createHash("md5").update(normalizedEmail).digest("hex");

    // Basic Gravatar URL
    const baseUrl = `https://www.gravatar.com/avatar/${emailHash}`;

    // Optional parameters
    const params: Array<string | number> = [];
    if (options.size) params.push(`s=${options.size}`);
    if (options.default) params.push(`d=${options.default}`);

    // Combine URL with parameters
    return params.length ? `${baseUrl}?${params.join("&")}` : baseUrl;
};

export function isCursor(obj) {
    return obj && typeof obj.next === "function" && typeof obj.toArray === "function";
}