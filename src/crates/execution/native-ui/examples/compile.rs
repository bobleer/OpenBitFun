//! Compiles the TSX on standard input and prints the factory (or the error).
use std::io::Read;

fn main() {
    let mut source = String::new();
    std::io::stdin().read_to_string(&mut source).expect("stdin");
    match openbitfun_native_ui::compile(&source) {
        Ok(module) => print!("{}", module.factory),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
