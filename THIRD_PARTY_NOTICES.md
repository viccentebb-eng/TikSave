# Third-party software

TikSave itself is distributed under the MIT License.

## dezoomify-rs

TikSave can automatically download and invoke **dezoomify-rs** as a separate external executable for reconstructing tiled / zoomable images.

- Project: `lovasoa/dezoomify-rs`
- Source: https://github.com/lovasoa/dezoomify-rs
- License: GNU General Public License v3.0 (GPL-3.0)
- Integration model: external executable launched as a separate process by TikSave.

TikSave does not copy dezoomify-rs source code into TikSave's Python or Firefox-extension source tree. When TikSave installs dezoomify-rs, it stores the upstream source URL, license identifier and—when GitHub is reachable—a copy of the upstream GPL-3.0 license text beside the installed executable.

If you redistribute a package that contains the dezoomify-rs binary itself, you are responsible for satisfying the GPL-3.0 distribution requirements for that binary, including the corresponding-source obligations that apply to your distribution method.
