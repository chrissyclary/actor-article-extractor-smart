const Apify = require('apify');
const extractor = require('unfluff');
const chrono = require('chrono-node');
const urlLib = require('url');
const moment = require('moment');

const { parseDateToMoment, loadAllDataset, executeExtendOutputFn, isDateValid, findDateInURL } = require('./utils.js');
const { countWords, isUrlArticle, isInDateRange } = require('./article-recognition.js');

const { log } = Apify.utils;

const MAX_DATASET_ITEMS_LOADED = 3 * 1000 * 1000;

const parseDomain = (url) => {
    if (!url) return null;
    const parsed = urlLib.parse(url);
    if (parsed && parsed.host) {
        return parsed.host.replace('www.', '');
    }
};

const completeHref = (parentUrl, path) => {
    const { protocol, host } = urlLib.parse(parentUrl);
    return `${protocol}//${host}${path}`
}

Apify.main(async () => {
    const input = await Apify.getValue('INPUT');
    console.log('input');
    console.dir(input);

    const {
        startUrls,
        onlyNewArticles = false,
        onlyInsideArticles = true,
        saveHtml = false,
        minWords = 150,
        dateFrom,
        isUrlArticleDefinition,
        mustHaveDate = true,
        pseudoUrls,
        linkSelector,
        maxDepth,
        maxPagesPerCrawl,
        maxArticlesPerCrawl,
        proxyConfiguration = { useApifyProxy: true },
        debug = false,
        extendOutputFunction,
    } = input;

    let articlesScraped = (await Apify.getValue('ARTICLES-SCRAPED')) || 0;
    Apify.events.on('migrating', async () => {
        await Apify.setValue('ARTICLES-SCRAPED', articlesScraped);
    });

    let extendOutputFunctionEvaled;
    try {
        extendOutputFunctionEvaled = eval(extendOutputFunction);
    } catch (e) {
        throw new Error(`extendOutputFunction is not a valid JavaScript! Error: ${e}`);
    }
    if (typeof extendOutputFunctionEvaled !== 'function') {
        throw new Error(`extendOutputFunction is not a function! Please fix it or use just default output!`);
    }


    // Valid format is either YYYY-MM-DD or format like "1 week" or "20 days"
    const parsedDateFrom = parseDateToMoment(dateFrom);
    console.log(parsedDateFrom);

    const arePseudoUrls = pseudoUrls && pseudoUrls.length > 0;
    if ((arePseudoUrls && !linkSelector) || (linkSelector && !arePseudoUrls)) {
        console.log('WARNING - If you use only Pseudo URLs or only Link selector, they will not work. You need to use them together.');
    }

    // Only relevant for incremental run
    const state = {};
    let stateDataset;
    if (onlyNewArticles) {
        console.log('loading state dataset...');
        const datasetToOpen = 'articles-state';
        stateDataset = await Apify.openDataset(datasetToOpen);
        const { itemCount } = await stateDataset.getInfo();
        const rawOffset = itemCount - MAX_DATASET_ITEMS_LOADED;
        const offset = rawOffset < 0 ? 0 : rawOffset;
        console.log(`State dataset contains ${itemCount} items, max dataset load is ${MAX_DATASET_ITEMS_LOADED}, offset: ${offset}`);
        const stateData = await loadAllDataset(stateDataset, [], offset);
        stateData.forEach((item) => {
            state[item.url] = true;
        });
        console.log('state prepared');
    }

    console.log(`We got ${startUrls.length} from the list`);

    const requestQueue = await Apify.openRequestQueue();

    for (const request of startUrls) {
        const { url } = request;
        console.log(`enquing start URL: ${url}`);
        if (request.userData && request.userData.label === 'ARTICLE') {
            await requestQueue.addRequest({ url, userData: { label: 'ARTICLE', index: 0, depth: 0 } });
        } else {
            await requestQueue.addRequest({ url, userData: { label: 'CATEGORY', index: 0, depth: 0 } });
        }
    }

    const handlePageFunction = async ({ request, $, body }) => {
        const title = $('title').text();

        const { loadedUrl } = request;

        if (title.includes('Attention Required!')) {
            throw new Error('We got captcha on:', request.url);
        }

        if (request.userData.label !== 'ARTICLE') {
            const loadedDomain = parseDomain(loadedUrl);
            console.log(`CATEGORY PAGE - requested URL: ${request.url}, loaded URL: ${loadedUrl}`);

            if (request.userData.depth >= maxDepth) {
                console.log(`Max depth of ${maxDepth} reached, not enqueueing any more request for --- ${request.url}`);
                return;
            }

            // all links
            const allHrefs = [];
            let aTagsCount = 0;
            $('a').each(function () {
                aTagsCount++;
                const relativeOrAbsoluteLink = $(this).attr('href');
                if (relativeOrAbsoluteLink) {
                    const absoluteLink = urlLib.resolve(loadedUrl, relativeOrAbsoluteLink);
                    allHrefs.push(absoluteLink);
                }
            });
            console.log(`total number of a tags: ${aTagsCount}`);
            console.log(`total number of links: ${allHrefs.length}`);

            let links = allHrefs;
            await Apify.setValue('LINKS', links);

            // filtered only inside links
            if (onlyInsideArticles) {
                links = allHrefs.filter((link) => loadedDomain === parseDomain(link));
                console.log(`number of inside links: ${links.length}`);
            }

            // filtered only new urls
            if (onlyNewArticles) {
                links = links.filter((href) => !state[href]);
                console.log(`number of inside links after state filter: ${links.length}`);
            }

            // filtered only proper article urls
            const articleUrlHrefs = links.filter((link) => isUrlArticle(link, isUrlArticleDefinition));
            console.log(`number of article url links: ${articleUrlHrefs.length}`);

            let index = 0;
            for (const url of articleUrlHrefs) {
                index++;
                await requestQueue.addRequest({
                    url,
                    userData: { domain: request.userData.domain, label: 'ARTICLE', index, loadedDomain },
                });
            }
            if (debug) {
                await Apify.setValue(Math.random().toString(), body, { contentType: 'text/html' });
            }

            // We handle optional pseudo URLs and link selectors here
            if (pseudoUrls && pseudoUrls.length > 0 && linkSelector) {
                const selectedLinks = $(linkSelector)
                    .map(function () { return $(this).attr('href'); }).toArray()
                    .filter((link) => !!link)
                    .map((link) => link.startsWith('http') ? link : completeHref(request.url, link));
                const purls = pseudoUrls.map((req) => new Apify.PseudoUrl(
                    req.url,
                    { userData: req.userData, depth: request.userData.depth + 1 }
                ));

                let enqueued = 0;
                for (const url of selectedLinks) {
                    for (const purl of purls) {
                        if (purl.matches(url)) {
                            // userData are passed along
                            await requestQueue.addRequest(purl.createRequest(url));
                            enqueued++;
                            break; // We finish the inner loop because the first PURL that matches wons
                        }
                    }
                }
                console.log(`Link selector found ${selectedLinks.length} links, enqueued through PURLs: ${enqueued} --- ${request.url}`);
            }
        }

        if (request.userData.label === 'ARTICLE') {
            const metadata = extractor(body);

            console.log('Raw date:', metadata.date);

            // We try native new Date() first and then Chrono
            let parsedPageDate;
            if (metadata.date) {
                const nativeDate = new Date(metadata.date);
                if (isDateValid(nativeDate)) {
                    parsedPageDate = moment(nativeDate.toISOString());
                } else {
                    parsedPageDate = chrono.parseDate(metadata.date);
                }
            }

            if (!parsedPageDate) {
                parsedPageDate = findDateInURL(request.url);
            }

            metadata.date = parsedPageDate || null;

            console.log('Parsed date:', metadata.date);

            const result = {
                url: request.url,
                loadedUrl,
                domain: request.userData.domain,
                loadedDomain: request.userData.loadedDomain,
                ...metadata,
                html: saveHtml ? body : undefined,
            };

            const userResult = await executeExtendOutputFn(extendOutputFunctionEvaled, $);
            const completeResult = { ...result, ...userResult };

            const wordsCount = countWords(completeResult.text);

            const isInDateRangeVar = isInDateRange(completeResult.date, parsedDateFrom);
            if (mustHaveDate && !isInDateRangeVar && !!completeResult.date) {
                console.log(`ARTICLE - ${request.userData.index} - DATE NOT IN RANGE: ${completeResult.date}`);
                return;
            }

            if (onlyNewArticles) {
                state[completeResult.url] = true;
                await stateDataset.pushData({ url: request.url });
            }

            const hasValidDate = mustHaveDate ? isInDateRangeVar : true;

            const isArticle =
                hasValidDate
                && !!completeResult.title
                && wordsCount > minWords;

            if (isArticle) {
                console.log(`IS VALID ARTICLE --- ${request.url}`);
                await Apify.pushData(completeResult);
                articlesScraped++;

                if (maxArticlesPerCrawl && articlesScraped >= maxArticlesPerCrawl) {
                    console.log(`WE HAVE REACHED MAXIMUM ARTICLES: ${maxArticlesPerCrawl}. FINISHING CRAWLING...`);
                    process.exit(0);
                }
            } else {
                console.log(`IS NOT VALID ARTICLE --- date: ${hasValidDate}, title: ${!!completeResult.title}, words: ${wordsCount}, dateRange: ${isInDateRangeVar} --- ${request.url}`);
            }
        }
    };

    const crawler = new Apify.CheerioCrawler({
        requestQueue,
        handlePageFunction,
        maxRequestRetries: 3,
        maxRequestsPerCrawl: maxPagesPerCrawl,
        useApifyProxy: proxyConfiguration.useApifyProxy,
        apifyProxyGroups: proxyConfiguration.apifyProxyGroups,
    });

    console.log('starting crawler...');
    await crawler.run();
    console.log('crawler finished...');
});
