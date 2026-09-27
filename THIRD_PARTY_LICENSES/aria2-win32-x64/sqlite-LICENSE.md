License Information
===================

SQLite Is Public Domain
-----------------------

The SQLite source code, including all of the files in the directories
listed in the bullets below are 
[Public Domain](https://sqlite.org/copyright.html).
The authors have submitted written affidavits releasing their work to
the public for any use.  Every byte of the public-domain code can be
traced back to the original authors.  The files of this repository
that are public domain include the following:

  *  All of the primary SQLite source code files found in the
     [src/ directory](https://sqlite.org/src/tree/src?type=tree&expand)
  *  All of the test cases and testing code in the
     [test/ directory](https://sqlite.org/src/tree/test?type=tree&expand)
  *  All of the SQLite extension source code and test cases in the
     [ext/ directory](https://sqlite.org/src/tree/ext?type=tree&expand)
  *  All code that ends up in the "sqlite3.c" and "sqlite3.h" build products
     that actually implement the SQLite RDBMS.
  *  All of the code used to compile the
     [command-line interface](https://sqlite.org/cli.html)
  *  All of the code used to build various utility programs such as
     "sqldiff", "sqlite3_rsync", and "sqlite3_analyzer".


The public domain source files usually contain a header comment
similar to the following to make it clear that the software is
public domain.

> The author disclaims copyright to this source code.  In place of
> a legal notice, here is a blessing:
> 
>   *   May you do good and not evil.
>   *   May you find forgiveness for yourself and forgive others.
>   *   May you share freely, never taking more than you give.

Almost every file you find in this source repository will be
public domain.  But there are a small number of exceptions:

Non-Public-Domain Code Included With This Source Repository AS A Convenience
----------------------------------------------------------------------------

This repository contains a (relatively) small amount of non-public-domain
code used to help implement the configuration and build logic.  In other
words, there are some non-public-domain files used to implement:

> ./configure && make

In all cases, the non-public-domain files included with this
repository have generous BSD-style licenses.  So anyone is free to
use any of the code in this source repository for any purpose, though
attribution may be required to reuse or republish the configure and
build scripts.  None of the non-public-domain code ever actually reaches
the build products, such as "sqlite3.c", however, so no attribution is
required to use SQLite itself.  The non-public-domain code consists of
scripts used to help compile SQLite.  The non-public-domain code is
technically not part of SQLite.  The non-public-domain code is
included in this repository as a convenience to developers, so that those
who want to build SQLite do not need to go download a bunch of
third-party build scripts in order to compile SQLite.

Non-public-domain code included in this respository includes:

  *  The ["autosetup"](http://msteveb.github.io/autosetup/) configuration
     system that is contained (mostly) in the autosetup/ directory, but also
     includes the "./configure" script at the top-level of this archive.
     Autosetup has a separate BSD-style license.  See the
     [autosetup/LICENSE](http://msteveb.github.io/autosetup/license/)
     for details.

  *  There are BSD-style licenses on some of the configuration
     software found in the legacy autoconf/ directory and its
     subdirectories.

The following unix shell command can be run from the top-level
of this source repository in order to remove all non-public-domain
code:

> rm -rf configure autosetup autoconf

If you unpack this source repository and then run the command above, what
is left will be 100% public domain.
