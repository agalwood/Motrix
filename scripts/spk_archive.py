"""Build-time SPK archive handling: regular files/directories only, no traversal."""
import pathlib
import sys
import tarfile


def extract(source, destination):
    root = pathlib.Path(destination)
    root.mkdir(parents=True, exist_ok=False)
    with tarfile.open(source, "r:*") as archive:
        names = set()
        total = 0
        for member in archive.getmembers():
            name = pathlib.PurePosixPath(member.name)
            if (name.is_absolute() or ".." in name.parts or "\\" in member.name
                    or not (member.isfile() or member.isdir())
                    or any(part.startswith("._") or part == ".DS_Store" for part in name.parts)
                    or member.mode & 0o7022 or name in names):
                raise ValueError("Unsafe or duplicate SPK member: " + member.name)
            names.add(name)
            total += member.size
            if total > 1024 * 1024 * 1024 or len(names) > 50000:
                raise ValueError("SPK exceeds extraction limits")
        for member in archive.getmembers():
            archive.extract(member, root, set_attrs=False, filter="data")
            target = root / member.name
            target.chmod(0o755 if member.isdir() or member.mode & 0o111 else 0o644)


if __name__ == "__main__":
    extract(sys.argv[1], sys.argv[2])
