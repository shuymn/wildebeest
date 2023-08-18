# Wildebeest [![codecov](https://codecov.io/gh/shuymn/wildebeest/graph/badge.svg?token=XW744B3TZA)](https://codecov.io/gh/shuymn/wildebeest)

_A Fork of [cloudflare/wildebeest](https://github.com/cloudflare/wildebeest) by [@shuymn](https://github.com/shuymn)_

![wildebeest illustration](https://imagedelivery.net/NkfPDviynOyTAOI79ar_GQ/3654789b-089c-493a-85b4-be3f8f594c00/header)

## About Wildebeest

Wildebeest is an [ActivityPub](https://www.w3.org/TR/activitypub/) and [Mastodon](https://joinmastodon.org/)-compatible server whose goal is to allow anyone to operate their Fediverse server and identity on their domain without needing to keep infrastructure, with minimal setup and maintenance, and running in minutes.

Wildebeest runs on top Cloudflare's [Supercloud](https://blog.cloudflare.com/welcome-to-the-supercloud-and-developer-week-2022/), uses [Workers](https://workers.cloudflare.com/), [Pages](https://pages.cloudflare.com/), [Durable Objects](https://developers.cloudflare.com/workers/learning/using-durable-objects/), [Queues](https://developers.cloudflare.com/queues/), the [D1 database](https://developers.cloudflare.com/d1/) to store metadata and configurations, [Zero Trust Access](https://www.cloudflare.com/en-gb/products/zero-trust/access/) to handle authentication and [Images](https://www.cloudflare.com/en-gb/products/cloudflare-images/) for media handling.

Currently, Wildebeest supports the following features:

- [ActivityPub](https://www.w3.org/TR/activitypub/), [WebFinger](https://www.rfc-editor.org/rfc/rfc7033), [NodeInfo](https://github.com/cloudflare/wildebeest/tree/main/functions/nodeinfo), [WebPush](https://datatracker.ietf.org/doc/html/rfc8030) and [Mastodon-compatible](https://docs.joinmastodon.org/api/) APIs. Wildebeest can connect to or receive connections from other Fediverse servers.
- Compatible with the most popular Mastodon web (like [Elk](https://github.com/elk-zone/elk)), desktop, and [mobile clients](https://joinmastodon.org/apps). We also provide a simple read-only web interface to explore the timelines and user profiles.
- You can publish, edit, boost, or delete posts, sorry, toots. We support text, images, and (soon) video.
- Anyone can follow you; you can follow anyone.
- You can search for content.
- You can register one or multiple accounts under your instance. Authentication can be email-based on or using any Cloudflare Access compatible IdP, like GitHub or Google.
- You can edit your profile information, avatar, and header image.

For more details on how Wildebeest was originally built, you can read Cloudflare's [announcement blog](https://blog.cloudflare.com/welcome-to-wildebeest-the-fediverse-on-cloudflare/).

## Please Read: Notes on This Wildebeest Fork

This repository is a fork of [cloudflare/wildebeest](https://github.com/cloudflare/wildebeest) and aims to build upon the original project by incorporating bug fixes and additional features.

While Wildebeest is a powerful tool, it is still under development and may contain some bugs or incomplete features. We are working diligently to improve it, but please use it with caution. We encourage you to fork this repository and experiment with Wildebeest - your participation is welcome!

We welcome all bug reports and feature requests. Please post them in the issues section. We are committed to improving this fork, and while it started as a personal project, we are open to community input and contributions.

## Tutorial

Follow this tutorial to deploy Wildebeest:

- [Requirements](docs/requirements.md)
- [Getting started](docs/getting-started.md)
- [Access policy](docs/access-policy.md)
- [Supported clients](docs/supported-clients.md)
- [Updating Wildebeest](docs/updating.md)
- [Other Cloudflare services](docs/other-services.md)
- [Troubleshooting](docs/troubleshooting.md)

## Acknowledgments

A big thank you to the original developers of [cloudflare/wildebeest](https://github.com/cloudflare/wildebeest). This project is based on their incredible work.

## License

This project is a fork of the [cloudflare/wildebeest](https://github.com/cloudflare/wildebeest) project, developed by Cloudflare, Inc. This fork is licensed under the same terms as the original project: the Apache License, Version 2.0.

For complete license information, see the [LICENSE](./LICENSE) file.
