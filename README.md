### Smart article extractor

This actor is an extension of Apify's [Article Text Extractor](https://apify.com/mtrunkat/article-text-extractor). It has several extra features:

- Allows extraction of any number of URLs - support for Start URLs, Pseudo URLs and max crawling depth
- Smart article recognition - Actor can decide what pages on a website are in fact articles to be scraped. This is customizable.
- Additional filters - Date of articles, minimum words
- Date normalization
- Some extra data fields
- Allows custom scraping function - You can add/overwrite your own fields from the parsed HTML

Example output:
- [JSON](https://api.apify.com/v2/datasets/mNg8AeuevQKjBhtTX/items?format=json&clean=1) (looks the best)
- [Table](https://api.apify.com/v2/datasets/mNg8AeuevQKjBhtTX/items?format=html&clean=1)
- [CSV](https://api.apify.com/v2/datasets/mNg8AeuevQKjBhtTX/items?format=csv&attachment=1&clean=1)

More detailed documentation to come...
