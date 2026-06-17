#!/usr/bin/env node

import { execSync } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function main() {
    console.log("Welcome to PSQLCarbon Installer!");
    console.log("This will install and set up PSQLCarbon.\n");
    
    const targetDirName = await question("What is your project named? (psqlcarbon-app): ") || "psqlcarbon-app";
    const targetPath = path.resolve(process.cwd(), targetDirName);

    if (fs.existsSync(targetPath)) {
        console.error(`Error: Directory ${targetDirName} already exists.`);
        process.exit(1);
    }

    console.log("\n=== Configuration ===");
    let username = "";
    while (true) {
        username = await question("Admin Username: ");
        if (!username || username.length <= 3) {
            console.log("Error: Username must be longer than 3 characters.");
        } else if (!/^[a-zA-Z0-9_.-]*$/.test(username)) {
            console.log("Error: Username can only contain letters, numbers, _, ., and -.");
        } else {
            break;
        }
    }

    let password = "";
    while (true) {
        password = await question("Admin Password: ");
        if (password.length < 6) {
            console.log("Error: Password must be at least 6 characters long.");
        } else if (!/[A-Z]/.test(password)) {
            console.log("Error: Password must contain at least one uppercase letter.");
        } else if (!/[a-z]/.test(password)) {
            console.log("Error: Password must contain at least one lowercase letter.");
        } else if (!/[0-9]/.test(password)) {
            console.log("Error: Password must contain at least one number.");
        } else if (!/[^a-zA-Z0-9]/.test(password)) {
            console.log("Error: Password must contain at least one special character.");
        } else {
            break;
        }
    }

    const port = await question("Port (default 3000): ") || "3000";
    
    console.log("\n=== AI Settings ===");
    const openAiApiKey = await question("OpenAI API Key (optional, press Enter to skip): ");
    let openAiBaseUrl = "https://api.openai.com/v1";
    let openAiModel = "gpt-4o";
    if (openAiApiKey) {
        openAiBaseUrl = await question("OpenAI Base URL (default https://api.openai.com/v1): ") || "https://api.openai.com/v1";
        openAiModel = await question("OpenAI Model (default gpt-4o): ") || "gpt-4o";
    }

    console.log(`\n> Cloning PSQLCarbon into ${targetPath}...`);
    execSync(`git clone https://github.com/n-for-all/psqlcarbon.git "${targetDirName}"`, { stdio: 'inherit' });
    
    process.chdir(targetPath);

    console.log("\n> Installing dependencies...");
    execSync(`npm install`, { stdio: 'inherit' });

    console.log("\n> Setting up environment variables...");
    const secret = crypto.randomBytes(32).toString('hex');
    const envContent = `DATABASE_URL="file:./db.db"\nSESSION_SECRET="${secret}"\nPORT=${port}\nSECURE_COOKIE=0\n`;
    fs.writeFileSync(path.join(targetPath, '.env'), envContent);

    console.log("\n> Initializing database...");
    execSync(`npm run prisma`, { stdio: 'inherit' });

    console.log("\n> Building the application...");
    execSync(`npm run build`, { stdio: 'inherit' });

    console.log("\n> Creating admin user...");
    const createUserCmd = `node console/user.js user --create --username "${username}" --password "${password}"`;
    execSync(createUserCmd, { stdio: 'inherit' });

    if (openAiApiKey) {
        console.log("\n> Saving AI settings...");
        const updateAiScript = `
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function updateAi() {
    await prisma.user.update({
        where: { username: "${username}" },
        data: {
            openAiApiKey: "${openAiApiKey}",
            openAiBaseUrl: "${openAiBaseUrl}",
            openAiModel: "${openAiModel}"
        }
    });
}
updateAi().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
        `;
        fs.writeFileSync(path.join(targetPath, 'update_ai.js'), updateAiScript);
        execSync(`node update_ai.js`, { stdio: 'inherit' });
        fs.unlinkSync(path.join(targetPath, 'update_ai.js'));
    }

    console.log(`\n=== Setup Complete! ===\n`);
    console.log(`You can now start the application:`);
    console.log(`  cd ${targetDirName}`);
    console.log(`  npm start`);

    const startNow = await question("\nDo you want to run the app now? (y/N): ");
    rl.close();
    
    if (startNow.toLowerCase() === 'y') {
        execSync(`npm start`, { stdio: 'inherit' });
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
