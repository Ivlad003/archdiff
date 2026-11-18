# Changelog

## 0.1.0

The first version, for an archdiff that says which repository it serves (after 0.8.0).

- The side panel shows the picture archdiff draws of what the tab shows on GitHub: the review of a pull request, of a comparison or of a branch off the main line, a commit's own change, the code of the main line or of a file — drawn by the `archdiff web` of your checkout, found on this computer by its remote.
- A pull request and a comparison are reviewed from where the head left the base, as GitHub lists their files. The pull request's branches are read from GitHub's API, or from its page for a private repository.
- A select switches between the pictures of a subject: the review, the layers with the change marked, the impact, the commits, the code.
- A shape tapped on the picture sends the tab to that file on GitHub: in the list of the change's files when the change touched it, else at the head's revision and its lines.
- Commits the checkout has not got are named with the command that fetches them; a server that is not running, with the command that starts it.
- English and Ukrainian, by the browser's language.
- *builds* opens the builds page with the version installed, which says whether a newer build is out.
