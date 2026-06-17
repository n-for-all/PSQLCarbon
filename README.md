<p align="center">
  <a href="https://psqlcarbon.com" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://storage.googleapis.com/ajaxy/psqlcarbon/logo-psqlcarbon.svg">
    <img alt="PSQLCarbon Logo" src="https://storage.googleapis.com/ajaxy/psqlcarbon/logo-psqlcarbon.svg?" width="280"/>
  </picture>
  </a>
</p>

<p align="center">
<a href="https://opensource.org/licenses/Apache-2.0">
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License">
</a>
</p>

<div align="center">
  <strong>
  <h2>A web-based MongoDB admin interface written with Remix, Vite, TailwindCSS and Prisma</h2><br />
  <a href="https://psqlcarbon.com">PSQLCarbon</a>: Similar to Mongo Express, MongoDB Compass, MongoUi...<br /><br />
  </strong>
  PSQLCarbon offers database management for mongodb instances
</div> 

<div class="flex" align="center">
  <br />
  <img alt="Instagram" src="https://storage.googleapis.com/ajaxy/psqlcarbon/logo-mongo.svg" height="48">
</div>

<p align="center">
  <br />
  <a href="https://psqlcarbon.com" rel="dofollow"><strong>Explore the docs »</strong></a>
  <br />
  </p>

<br />

<p align="center">
  <img src="https://storage.googleapis.com/ajaxy/psqlcarbon/psqlcarbon-screenshot.jpg?x32" width="100%" />
</p>

[![npm version](https://badge.fury.io/js/psqlcarbon.svg)](https://www.npmjs.com/package/psqlcarbon) [![npm](https://img.shields.io/npm/dm/psqlcarbon.svg)](https://www.npmjs.com/package/psqlcarbon) [![GitHub stars](https://img.shields.io/github/stars/n-for-all/psqlcarbon.svg)](https://github.com/n-for-all/psqlcarbon/stargazers) [![Known Vulnerabilities](https://snyk.io/test/npm/name/badge.svg)](https://snyk.io/test/npm/psqlcarbon)

## Features

-   Multiple Connections
-   View/add/delete databases
-   View/add/delete collections
-   Use BSON data types in documents
-   Mobile / Responsive
-   Database blacklist/whitelist
-   Custom CA/TLS/SSL and CA validation disabling
-   Supports replica sets and direct connection
-   Includes PM2 config

## Road Map
- [ ] Rename Collections 
- [ ] View/add/update/delete documents
- [ ] Export/Import documents
- [ ] Export/Import collections
- [ ] Preview audio/video/image assets in the document view


## Development

To test or develop with the latest version (_master_ branch) you can download using this git repository:

**Run the development build using:**

    npm i && npm run dev

## Usage (npm / yarn / pnpm / CLI)

_psqlcarbon_ requires Node.js v18 or higher.

**To install:**

    npm i -g psqlcarbon
    OR
    yarn add -g psqlcarbon
    OR
    pnpm add -g psqlcarbon

Or if you want to install a non-global copy:

    npm i psqlcarbon
    OR
    yarn add psqlcarbon
    OR
    pnpm add psqlcarbon

Then create the first user using the terminal ex:

    cd node_modules/psqlcarbon && node console/user.js user --create --username USERNAME --password YOUR_PASSWORD

You can also delete the user using the terminal ex:

    cd node_modules/psqlcarbon && node console/user.js user --delete --username USERNAME

**After Installation:**

The post install will create a folder "psqlcarbon" and .env (if not exists, otherwise it will append the value) inside your app root directory, these files are needed once you update psqlcarbon so you don't lose access to the portal

**To configure:**

The installation will create a `.env` file with default settings, if you prefer to change them, you can edit the `.env` file with the following settings and replace the DATABASE_URL and SESSION_SECRET with a new secret:

    DATABASE_URL="file:./db.db"
    SESSION_SECRET=8df3f6d031e4eff1a00bce856014442e07773252c1e9fb38a552001aef37e476`

**To run:**

    cd YOUR_PATH/node_modules/psqlcarbon/ && npm start

or if you installed it globally, you can immediately start psqlcarbon like this:

    psqlcarbon

**PM2:**

    cd YOUR_PATH/node_modules/psqlcarbon/ && pm2 start app.config.js

## Can't login?

You must be using https to login otherwise you need to add SECURE_COOKIE=0 to your .env file in the root of your project

## Usage (Docker)

Make sure you have a running [MongoDB container](https://hub.docker.com/_/mongo/) on a Docker network (`--network some-network` below) with `--name` or `--network-alias` set to `mongo` and then create the user

**Use [the Docker Hub image](https://hub.docker.com/_/psqlcarbon/):**

```console
$ docker run -it --rm -p 3000:3000 --network some-network psqlcarbon
```

**Build from source:**

Build an image from the project directory, then run the image.

```console
$ docker build -t psqlcarbon .
$ docker run -it --rm -p 3000:3000 --network some-network psqlcarbon
```

**To use:**

The default port exposed from the container is 3000, so visit `http://localhost:3000` or whatever URL/port you entered into your config (if running standalone) or `http://localhost:5137` in dev mode.

### Using Docker Extensions:

**Pre-requisite:**

-   Docker Desktop 4.15


## Usage (IBM Cloud)

**Deploy to IBM Cloud**

Doing manually:

-   Git clone this repository
-   Create a new or use already created [MongoDB service](https://www.ibm.com/products/databases-for-mongodb)
-   Change the file `examples/ibm-cloud/manifest.yml` to fit your IBM Cloud app and service environment

Doing automatically:

-   Click the button below to fork into IBM DevOps Services and deploy your own copy of this application on IBM Cloud

[![Deploy to IBM Cloud](https://cloud.ibm.com/devops/setup/deploy/button_x2.png)](https://cloud.ibm.com/devops/setup/deploy?repository=https://github.com/psqlcarbon/psqlcarbon.git)

Then, take the following action to customize to your environment:

-   Create your `.env` and create a new user to access the portal

## Planned features

Pull Requests are always welcome! <3

**psqlcarbon should only be used privately for development purposes**.
